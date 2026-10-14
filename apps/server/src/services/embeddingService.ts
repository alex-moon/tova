import { config } from '../config';

/*
 * #294: embedding client for workspace-memory semantic retrieval.
 *
 * DeepInfra exposes an OpenAI-compatible embeddings endpoint and is already a
 * configured provider with a key (`config.providers.deepinfraApiKey`), so no
 * new secret or vendor is introduced. The endpoint is a single POST, so this
 * is a thin `fetch` rather than a new runtime dependency (`ai` /
 * `@ai-sdk/deepinfra` / `openai` are not installed). This is a deliberate,
 * documented exception to the repo's library-first rule; see
 * docs/plan-294-workspace-retrieval.md (Risks).
 *
 * BGE v1.5 wants an instruction prefix on *queries* only; passages take no
 * prefix. `kind` selects which side of the retrieval a call is on.
 */

const DEEPINFRA_BASE = 'https://api.deepinfra.com/v1';
const EMBEDDINGS_URL = `${DEEPINFRA_BASE}/openai/embeddings`;

export const EMBEDDING_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export type EmbedKind = 'query' | 'passage';

export interface EmbedOptions {
  kind?: EmbedKind;
  // Injectable for tests; defaults to global `fetch`.
  fetchImpl?: typeof fetch;
  // Overrides `config.embeddings.timeoutMs` for this call. The config default
  // bounds the one-text query embed on the chat hot path; a backfill batch of
  // 64 passages needs far longer (observed: the 800ms default times out on
  // real batches).
  timeoutMs?: number;
}

// Thrown when the provider key is absent: a configuration fault the caller
// must not treat as "no results".
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingConfigError';
  }
}

// Thrown on transport/HTTP/shape faults from the provider.
export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseError';
  }
}

interface EmbeddingRow {
  embedding?: unknown;
  index?: unknown;
}

interface EmbeddingsBody {
  data?: unknown;
}

const orderRows = (rows: EmbeddingRow[]): EmbeddingRow[] => {
  if (!rows.every((row) => typeof row.index === 'number')) return rows;
  return [...rows].sort((a, b) => (a.index as number) - (b.index as number));
};

/*
 * Embed a batch of texts. Returns one vector per input, in input order, each
 * validated against `config.embeddings.dim` (a mismatch means the configured
 * model and dimension have diverged, which would corrupt the Atlas index).
 * An empty batch short-circuits without a network call.
 *
 * Context-length recovery: BGE v1.5 models hard-reject any input over the
 * model's 512-token context with a 400, and the client-side
 * `EMBEDDING_MAX_CHARS` cap cannot see token density (code/YAML/OCR text
 * tokenises far denser than the ~3.5 chars/token the cap assumes). On that
 * error the batch falls back to per-text calls, each halving its text until it
 * fits (deterministic per text, so the backfill's hash-skip rule stays
 * correct); below `EMBED_MIN_CHARS` it fails loudly instead.
 */
export const EMBED_MIN_CHARS = 32;

export class ContextLengthError extends EmbeddingResponseError {}

export const embedTexts = async (texts: string[], opts: EmbedOptions = {}): Promise<number[][]> => {
  if (texts.length === 0) return [];

  const apiKey = config.providers.deepinfraApiKey;
  if (!apiKey) {
    throw new EmbeddingConfigError(
      'DEEPINFRA_API_KEY is not configured — cannot embed workspace slices',
    );
  }

  const kind: EmbedKind = opts.kind ?? 'passage';
  const withPrefix = texts.map((text) =>
    kind === 'query' ? `${EMBEDDING_QUERY_PREFIX}${text}` : text,
  );
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? config.embeddings.timeoutMs;

  const request = async (inputs: string[]): Promise<number[][]> => {
    const response = await doFetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.embeddings.model, input: inputs }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      if (response.status === 400 && /context length|maximum input length/i.test(body)) {
        throw new ContextLengthError(
          `DeepInfra embeddings rejected the input length: ${body.slice(0, 200)}`,
        );
      }
      throw new EmbeddingResponseError(`DeepInfra embeddings returned HTTP ${response.status}`);
    }

    const bodyJson = (await response.json().catch(() => null)) as EmbeddingsBody | null;
    const rows = Array.isArray(bodyJson?.data) ? (bodyJson.data as EmbeddingRow[]) : [];
    const ordered = orderRows(rows);
    if (ordered.length !== inputs.length) {
      throw new EmbeddingResponseError(
        `DeepInfra embeddings returned ${ordered.length} vectors for ${inputs.length} inputs`,
      );
    }

    const dim = config.embeddings.dim;
    return ordered.map((row, i) => {
      const vector = row.embedding;
      if (!Array.isArray(vector) || !vector.every((value) => typeof value === 'number')) {
        throw new EmbeddingResponseError(`DeepInfra embeddings row ${i} is not a numeric vector`);
      }
      if (vector.length !== dim) {
        throw new EmbeddingResponseError(
          `DeepInfra embeddings row ${i} has dimension ${vector.length}, expected ${dim}`,
        );
      }
      return vector as number[];
    });
  };

  const run = async (inputs: string[]): Promise<number[][]> => {
    try {
      return await request(inputs);
    } catch (err) {
      if (!(err instanceof ContextLengthError)) throw err;
      if (inputs.length > 1) {
        const perText = await Promise.all(inputs.map((text) => run([text])));
        return perText.flat();
      }
      const text = inputs[0];
      const half = text.slice(0, Math.ceil(text.length / 2));
      if (half.length < EMBED_MIN_CHARS) {
        throw new EmbeddingResponseError(
          `DeepInfra embeddings input exceeds the model context even after truncation ` +
            `(${text.length} chars left)`,
        );
      }
      return run([half]);
    }
  };

  return run(withPrefix);
};
