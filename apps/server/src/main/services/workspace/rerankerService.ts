import { config } from '../../config/index';

/* Cross-encoder reranker via DeepInfra; failures degrade to null. */
// @see #305

const DEEPINFRA_BASE = 'https://api.deepinfra.com/v1';
export const RERANK_MODEL = 'Qwen/Qwen3-Reranker-0.6B';
const RERANK_URL = `${DEEPINFRA_BASE}/inference/${RERANK_MODEL}`;

export interface RerankOptions {
  // Injectable for tests; defaults to global `fetch`.
  fetchImpl?: typeof fetch;
  // Overrides `config.rerank.timeoutMs` for this call.
  timeoutMs?: number;
}

interface RerankBody {
  scores?: unknown;
}

/* Grade one query against documents; null when the stage cannot run. */
export const rerankQuery = async (
  query: string,
  documents: string[],
  opts: RerankOptions = {},
): Promise<number[] | null> => {
  if (documents.length === 0) return [];

  const apiKey = config.providers.deepinfraApiKey;
  if (!apiKey) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? config.rerank.timeoutMs;
  try {
    const response = await doFetch(RERANK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: RERANK_MODEL, queries: [query], documents }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.error(`DeepInfra reranker returned HTTP ${response.status} — cutting disabled`);
      return null;
    }
    const bodyJson = (await response.json().catch(() => null)) as RerankBody | null;
    const scores = Array.isArray(bodyJson?.scores) ? (bodyJson.scores as unknown[]) : [];
    if (scores.length !== documents.length || !scores.every((s) => typeof s === 'number')) {
      console.error('DeepInfra reranker returned a malformed score array — cutting disabled');
      return null;
    }
    return scores as number[];
  } catch (err) {
    console.error('DeepInfra reranker call failed — cutting disabled:', err);
    return null;
  }
};
