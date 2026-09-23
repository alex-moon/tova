import { config } from '../config';

/*
 * Best-effort LangSmith trace deletion (issue #143, factory reset scope).
 *
 * Every chat turn is traced into the configured LangSmith project with
 * `metadata.session_id = <chat session id>` (set via withLangsmithMetadata in
 * mastraService), so traces belonging to a chat are deletable by that id:
 *
 *  - resolve the project's LangSmith id from its name (GET /api/v1/sessions)
 *  - query the run ids (POST /api/v1/runs/query, filter on
 *    metadata_key/metadata_value — the documented compliance pattern)
 *  - batch-delete the trace ids (POST /api/v1/runs/delete)
 *
 * Known limitations, all deliberate: the delete endpoint is asynchronous
 * (LangSmith returns 202 "queued" and does not confirm that any run matched,
 * so we cannot verify a deletion succeeded); it may be rate-limited or
 * disallowed by org policy; a run exported between our Mongo sweep and this
 * query can be missed. Consequently the whole service is failure-tolerant —
 * it logs and returns, never throwing, so a trace problem can never abort the
 * rest of the factory reset. Without an API key the exporter never ran
 * (mastraService gates on the same env), so the purge is a silent no-op —
 * dev/stub parity.
 */

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
    const runs = (await queryRes.json()) as { trace_id?: string }[];
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
    // Name-match only: falling back to the first session returned would risk
    // issuing deletes against a project the config never named.
    const projectId = sessions.find((s) => s.name === project)?.id;
    if (!projectId) {
      throw new Error(`project "${project}" not found`);
    }

    for (const sessionId of sessionIds) {
      try {
        await purgeSessionTraces(sessionId, headers, projectId);
      } catch (err) {
        // One session failing (rate limit, HTTP error) must not give up on the
        // remaining ones — each session's traces are a separate best-effort
        // chunk, so continue and let the failure be logged.
        console.error('trace purge (best-effort) failed for a session:', String(err));
      }
    }
  } catch (err) {
    console.error('trace purge (best-effort) failed:', String(err));
  }
};
