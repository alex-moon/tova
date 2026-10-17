import {
  EMBEDDING_QUERY_PREFIX,
  EmbeddingConfigError,
  EmbeddingResponseError,
  embedTexts,
} from '../../main/services/embeddingService';

/* The embedding client is a thin DeepInfra OpenAI-compatible POST; every test injects `fetchImpl` — the suite must never make a live provider call. */
// @see #294

const originalKey = process.env.DEEPINFRA_API_KEY;
const originalDim = process.env.EMBEDDING_DIM;
const originalModel = process.env.EMBEDDING_MODEL;

// The `fetch` init shape the service builds; `RequestInit` is a DOM lib type not available under this tsconfig's `types`.
interface FetchInit {
  headers?: unknown;
  body?: string;
}

const vector = (dim: number, seed = 0): number[] =>
  Array.from({ length: dim }, (_, i) => (i + seed) / dim);

const okResponse = (vectors: number[][], indices?: number[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: vectors.map((embedding, i) => ({
      object: 'embedding',
      index: indices ? indices[i] : i,
      embedding,
    })),
  }),
});

describe('embedTexts (#294)', () => {
  beforeEach(() => {
    process.env.DEEPINFRA_API_KEY = 'test-key';
    process.env.EMBEDDING_DIM = '4';
    delete process.env.EMBEDDING_MODEL;
  });

  afterAll(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('DEEPINFRA_API_KEY', originalKey);
    restore('EMBEDDING_DIM', originalDim);
    restore('EMBEDDING_MODEL', originalModel);
  });

  it('posts the batch to the DeepInfra embeddings endpoint and returns vectors', async () => {
    const fetchImpl = jest.fn(async () => okResponse([vector(4)]));
    const result = await embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual([vector(4)]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, FetchInit];
    expect(url).toBe('https://api.deepinfra.com/v1/openai/embeddings');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'BAAI/bge-base-en-v1.5',
      input: ['hello'],
    });
  });

  it('embeds a batch in one call and preserves input order', async () => {
    const fetchImpl = jest.fn(async () =>
      okResponse([vector(4, 10), vector(4, 20), vector(4, 30)], [2, 0, 1]),
    );
    const result = await embedTexts(['a', 'b', 'c'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Sorted by `index`, so the returned order matches the input order.
    expect(result).toEqual([vector(4, 20), vector(4, 30), vector(4, 10)]);
  });

  it('prepends the BGE instruction prefix to queries only', async () => {
    const queryFetch = jest.fn(async () => okResponse([vector(4)]));
    await embedTexts(['what about my partner'], {
      kind: 'query',
      fetchImpl: queryFetch as unknown as typeof fetch,
    });
    const [, queryInit] = queryFetch.mock.calls[0] as unknown as [string, FetchInit];
    expect(JSON.parse(queryInit.body as string).input).toEqual([
      `${EMBEDDING_QUERY_PREFIX}what about my partner`,
    ]);

    const passageFetch = jest.fn(async () => okResponse([vector(4)]));
    await embedTexts(['what about my partner'], {
      kind: 'passage',
      fetchImpl: passageFetch as unknown as typeof fetch,
    });
    const [, passageInit] = passageFetch.mock.calls[0] as unknown as [string, FetchInit];
    expect(JSON.parse(passageInit.body as string).input).toEqual(['what about my partner']);
  });

  it('short-circuits an empty batch without a network call', async () => {
    const fetchImpl = jest.fn();
    expect(await embedTexts([], { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a config error when the key is absent', async () => {
    delete process.env.DEEPINFRA_API_KEY;
    const fetchImpl = jest.fn();
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(EmbeddingConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps provider order when rows carry no numeric index', async () => {
    // The `index` field is optional on the wire; when absent the client must not reorder, since there is nothing to sort by.
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: vector(4, 10) }, { embedding: vector(4, 20) }],
      }),
    }));
    const result = await embedTexts(['a', 'b'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([vector(4, 10), vector(4, 20)]);
  });

  it('throws a response error when the body is not valid JSON', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected end of JSON');
      },
    }));
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(EmbeddingResponseError);
  });

  it('throws a response error on a non-200', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(EmbeddingResponseError);
  });

  it('throws when a returned vector length diverges from the configured dim', async () => {
    const fetchImpl = jest.fn(async () => okResponse([vector(3)]));
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/dimension 3, expected 4/);
  });

  it('throws when the provider returns the wrong number of vectors', async () => {
    const fetchImpl = jest.fn(async () => okResponse([vector(4)]));
    await expect(
      embedTexts(['a', 'b'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it('throws when a returned row is not a numeric vector', async () => {
    const fetchImpl = jest.fn(async () => okResponse([[1, 2, 'x', 4] as unknown as number[]]));
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/not a numeric vector/);
  });

  it('recovers a context-length 400 by splitting per text and halving the offender', async () => {
    // `EMBEDDING_MAX_CHARS` cannot see token density, so a code-dense slice can still exceed the model's window and 400 the whole batch; clean text must come back intact and in order, with only the offender retried, halved until it fits.
    const dense = 'x'.repeat(3000);
    const contextError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message:
              "the model's context length is only 512 tokens, resulting in a maximum input length of 512 tokens",
          },
        }),
    };
    const fetchImpl = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      const input = (JSON.parse((init as FetchInit).body as string) as { input: string[] }).input;
      if (input.length > 1) return contextError;
      if (input[0].length > 700) return contextError;
      return okResponse([vector(4, input[0].length)]);
    });
    const result = await embedTexts(['clean passage', dense], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([vector(4, 'clean passage'.length), vector(4, 375)]);
    // 1 batch call + 2 per-text calls + (1500, 750, 375) offender retries.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('fails loudly when an input cannot shrink below the context floor', async () => {
    const contextError = {
      ok: false,
      status: 400,
      text: async () => 'maximum input length of 512 tokens',
    };
    const fetchImpl = jest.fn(async () => contextError);
    await expect(
      embedTexts(['a'.repeat(40)], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/exceeds the model context even after truncation/);
  });

  it('keeps a non-context 400 as a plain response error', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"bad request"}}',
    }));
    await expect(
      embedTexts(['hello'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 400/);
  });
});
