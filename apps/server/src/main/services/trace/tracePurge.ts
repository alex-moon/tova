import { config } from '../../config/index';
import { headersFor, queryRuns, resolveProject } from '../langsmithTracesService';

/* Best-effort LangSmith trace deletion by session id; never throws.
 * Runs on the shared admin plumbing (retries, project resolution). */
// @see #143 #224 #398

const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DELETE_BATCH = 100;
const FETCH_TIMEOUT_MS = 10_000;

// Session ids are our own ObjectIds; the shape assertion keeps quote
// characters out of the filter-string interpolation.
// @see #397
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;

const sessionMetadataFilter = (sessionId: string): string =>
  `and(in(metadata_key, ["session_id"]), eq(metadata_value, ${JSON.stringify(sessionId)}))`;

const purgeSessionTraces = async (
  sessionId: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<void> => {
  if (!OBJECT_ID_PATTERN.test(sessionId)) {
    throw new Error('session id is not an ObjectId hex string');
  }
  const traceIds = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await queryRuns(headers, projectId, {
      filter: sessionMetadataFilter(sessionId),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    // The endpoint answers an object; a non-array must throw, not read empty.
    const runs = body.runs;
    if (!Array.isArray(runs)) throw new Error('unexpected run query response shape');
    for (const run of runs) if (run.trace_id) traceIds.add(run.trace_id);
    if (runs.length < PAGE_SIZE) break;
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

  const headers = headersFor(apiKey);

  try {
    const { id: projectId } = await resolveProject(headers, project);
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
