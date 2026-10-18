import { config } from '../config';

/* Best-effort LangSmith trace deletion by session id; never throws. */
// @see #143 #224

const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DELETE_BATCH = 100;

const sessionMetadataFilter = (sessionId: string): string =>
  `and(in(metadata_key, ["session_id"]), eq(metadata_value, "${sessionId}"))`;

const purgeSessionTraces = async (
  sessionId: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<void> => {
  const traceIds = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const queryRes = await fetch(`${BASE_URL}/api/v1/runs/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: [projectId],
        filter: sessionMetadataFilter(sessionId),
        limit: PAGE_SIZE,
        offset,
      }),
    });
    if (!queryRes.ok) {
      throw new Error(`run query failed: HTTP ${queryRes.status}`);
    }
    // The endpoint answers an object; a non-array must throw, not read empty.
    const body = (await queryRes.json()) as { runs?: { trace_id?: string }[] };
    const runs = body.runs;
    if (!Array.isArray(runs)) throw new Error('unexpected run query response shape');
    for (const run of runs) if (run.trace_id) traceIds.add(run.trace_id);
    if (runs.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const ids = [...traceIds];
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const deleteRes = await fetch(`${BASE_URL}/api/v1/runs/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: projectId,
        trace_ids: ids.slice(i, i + DELETE_BATCH),
      }),
    });
    if (!deleteRes.ok) {
      throw new Error(`run delete failed: HTTP ${deleteRes.status}`);
    }
  }
};

export const purgeUserTraces = async (sessionIds: string[]): Promise<void> => {
  const apiKey = config.langsmith.apiKey;
  const project = config.langsmith.project;
  if (!apiKey || !project || sessionIds.length === 0) return;

  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };

  try {
    const res = await fetch(
      `${BASE_URL}/api/v1/sessions?name=${encodeURIComponent(project)}&limit=1`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`project lookup failed: HTTP ${res.status}`);
    }
    const sessions = (await res.json()) as { id?: string; name?: string }[];
    // Name-match only; a fallback could hit the wrong project.
    const projectId = sessions.find((s) => s.name === project)?.id;
    if (!projectId) {
      throw new Error(`project "${project}" not found`);
    }

    for (const sessionId of sessionIds) {
      try {
        await purgeSessionTraces(sessionId, headers, projectId);
      } catch (err) {
        // One session failing must not give up on the remaining ones.
        console.error('trace purge (best-effort) failed for a session:', String(err));
      }
    }
  } catch (err) {
    console.error('trace purge (best-effort) failed:', String(err));
  }
};
