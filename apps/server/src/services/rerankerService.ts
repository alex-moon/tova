import { config } from '../config';

/*
 * #305: cross-encoder reranker client for workspace-memory retrieval via
 * DeepInfra — no new secret or vendor (the key is already configured for
 * embeddings). Same thin-fetch stance as `embeddingService.ts`: a single POST,
 * no runtime dependency.
 *
 * Model note: #305 named `BAAI/bge-reranker-v2-m3`, but DeepInfra no longer
 * serves it (404 "Model is not available"; their catalog hosts no reranker).
 * The Qwen3-Reranker family is served with the same `{queries, documents} ->
 * {scores}` contract; the 0.6B showed the crispest absolute separation in the
 * #305 calibration probe (relevant ≈ 0.98, irrelevant ≈ 0.0002) at the lowest
 * price and latency.
 *
 * Scores are relevance probabilities in [0, 1] per the docs — an absolute,
 * corpus-independent quality bar a cut threshold can actually sit under.
 *
 * Never throws: every failure (missing key, transport, HTTP, malformed shape)
 * degrades to `null`, which the caller treats as "no rerank" — retrieval falls
 * back to the unfused/un-cut ranking, never an error on a chat turn.
 */

const DEEPINFRA_BASE = 'https://api.deepinfra.com/v1';
export const RERANK_MODEL = 'Qwen/Qwen3-Reranker-0.6B';
const RERANK_URL = `${DEEPINFRA_BASE}/inference/${RERANK_MODEL}`;

export interface RerankOptions {
  // Injectable for tests; defaults to global `fetch`.
  fetchImpl?: typeof fetch;
  // Overrides `config.embeddings.timeoutMs` for this call.
  timeoutMs?: number;
}

interface RerankBody {
  scores?: unknown;
}

/*
 * Grade one query against a batch of documents. Returns one relevance
 * probability per document, in input order — or `null` when the stage cannot
 * run or fails (the caller's degrade-to-current-behaviour signal).
 */
export const rerankQuery = async (
  query: string,
  documents: string[],
  opts: RerankOptions = {},
): Promise<number[] | null> => {
  if (documents.length === 0) return [];

  const apiKey = config.providers.deepinfraApiKey;
  if (!apiKey) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? config.embeddings.timeoutMs;
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
