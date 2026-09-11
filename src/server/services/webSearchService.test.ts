import { webSearch, type SearchResult } from './webSearchService';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

const realFetch = global.fetch;

afterAll(() => {
  consoleErrorSpy.mockRestore();
  global.fetch = realFetch;
});

describe('Web Search Service', () => {
  const originalKey = process.env.BRAVE_API_KEY;

  const originalSearchKey = process.env.BRAVE_SEARCH_API_KEY;

  beforeEach(() => {
    consoleErrorSpy.mockClear();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env.BRAVE_API_KEY = originalKey;
    process.env.BRAVE_SEARCH_API_KEY = originalSearchKey;
  });

  describe('cleans degradation when the key is unset', () => {
    it('returns [] without calling the API when no key is set', async () => {
      delete process.env.BRAVE_API_KEY;
      delete process.env.BRAVE_SEARCH_API_KEY;
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      await expect(webSearch('anything')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns [] when BRAVE_API_KEY is an empty string', async () => {
      process.env.BRAVE_API_KEY = '';
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      await expect(webSearch('anything')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to BRAVE_SEARCH_API_KEY when BRAVE_API_KEY is unset', async () => {
      delete process.env.BRAVE_API_KEY;
      process.env.BRAVE_SEARCH_API_KEY = 'alt-key';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ web: { results: [] } }),
      });
      await expect(webSearch('q')).resolves.toEqual([]);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Subscription-Token': 'alt-key' }),
        }),
      );
    });
  });

  describe('with a key present', () => {
    beforeEach(() => {
      process.env.BRAVE_API_KEY = 'test-key';
      delete process.env.BRAVE_SEARCH_API_KEY;
    });

    it('maps Brave web results to SearchResults', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            web: {
              results: [
                {
                  title: 'Result A',
                  description: 'Snippet A',
                  url: 'https://a.example.com',
                  extra: 'dropped',
                },
                {
                  title: 'Result B',
                  description: 'Snippet B',
                  url: 'https://b.example.com',
                },
              ],
            },
          }),
      });
      const results: SearchResult[] = await webSearch('groq news');
      expect(results).toEqual([
        { title: 'Result A', snippet: 'Snippet A', url: 'https://a.example.com' },
        { title: 'Result B', snippet: 'Snippet B', url: 'https://b.example.com' },
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('q=groq%20news'),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Subscription-Token': 'test-key' }),
        }),
      );
    });

    it('tolerates results missing fields', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            web: {
              results: [
                { title: 'No URL', description: 'should be dropped' },
                { title: null, description: 'ok snippet', url: 'https://ok.example.com' },
                null,
              ],
            },
          }),
      });
      await expect(webSearch('q')).resolves.toEqual([
        { title: '', snippet: 'ok snippet', url: 'https://ok.example.com' },
      ]);
    });

    it('returns [] when the response has no web results', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      await expect(webSearch('q')).resolves.toEqual([]);
    });

    it('returns [] on non-ok HTTP responses', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
      await expect(webSearch('q')).resolves.toEqual([]);
    });

    it('returns [] on network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
      await expect(webSearch('q')).resolves.toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('returns [] on a malformed JSON body instead of throwing', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('invalid JSON')) });
      await expect(webSearch('q')).resolves.toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('does not hit the API for a blank query even with a key', async () => {
      process.env.BRAVE_API_KEY = 'test-key';
      global.fetch = jest.fn();
      await expect(webSearch('   ')).resolves.toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends the auth header', async () => {
      let capturedHeaders: Record<string, string> | undefined;
      global.fetch = jest.fn().mockImplementation((_url, init) => {
        capturedHeaders = init?.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ web: { results: [] } }) });
      });
      await webSearch('q');
      expect(capturedHeaders).toMatchObject({ 'X-Subscription-Token': 'test-key' });
    });
  });
});
