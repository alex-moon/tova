import { RERANK_MODEL, rerankQuery } from './rerankerService';

/*
 * #305: the reranker client is a thin DeepInfra POST that never throws — every
 * failure degrades to `null` so retrieval can fall back to the un-cut ranking.
 * Every test injects `fetchImpl` — the suite must never make a live call.
 */

const originalKey = process.env.DEEPINFRA_API_KEY;

interface FetchInit {
  headers?: unknown;
  body?: string;
}

const okResponse = (scores: number[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ scores }),
});

describe('rerankQuery (#305)', () => {
  beforeEach(() => {
    process.env.DEEPINFRA_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = originalKey;
  });

  it('posts the query and documents to the DeepInfra rerank endpoint and returns scores in order', async () => {
    const fetchImpl = jest.fn(async (url: string | URL, init?: FetchInit) => {
      expect(String(url)).toBe(`https://api.deepinfra.com/v1/inference/${RERANK_MODEL}`);
      const body = JSON.parse(init?.body ?? '{}') as {
        model?: string;
        queries?: string[];
        documents?: string[];
      };
      expect(body.model).toBe(RERANK_MODEL);
      expect(body.queries).toEqual(['what is the budget']);
      expect(body.documents).toEqual(['twelve thousand', 'unrelated']);
      return okResponse([0.97, 0.0001]);
    });
    const scores = await rerankQuery('what is the budget', ['twelve thousand', 'unrelated'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(scores).toEqual([0.97, 0.0001]);
  });

  it('returns [] for an empty document batch without a network call', async () => {
    const fetchImpl = jest.fn();
    expect(await rerankQuery('q', [], { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual(
      [],
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('degrades to null when the key is absent', async () => {
    delete process.env.DEEPINFRA_API_KEY;
    const fetchImpl = jest.fn();
    expect(await rerankQuery('q', ['d'], { fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(
      null,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('degrades to null on an HTTP error', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 500, json: async () => null }));
    expect(await rerankQuery('q', ['d'], { fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(
      null,
    );
  });

  it('degrades to null on a malformed score array', async () => {
    const fetchImpl = jest.fn(async () => okResponse([0.5])); // 1 score for 2 docs
    expect(
      await rerankQuery('q', ['d1', 'd2'], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toBe(null);
    const nonNumeric = jest.fn(async () => okResponse(['high' as unknown as number]));
    expect(
      await rerankQuery('q', ['d1'], { fetchImpl: nonNumeric as unknown as typeof fetch }),
    ).toBe(null);
  });

  it('degrades to null when the call throws', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('boom');
    });
    expect(await rerankQuery('q', ['d'], { fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(
      null,
    );
  });
});
