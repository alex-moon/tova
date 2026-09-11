import { webSearch, type SearchResult } from './webSearchService';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

describe('Web Search Service', () => {
  const originalKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    consoleErrorSpy.mockClear();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env.BRAVE_API_KEY = originalKey;
  });

  describe('cleans degradation when the key is unset', () => {
    it('returns [] without calling the API when BRAVE_API_KEY is unset', async () => {
      delete process.env.BRAVE_API_KEY;
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
  });

  describe('with a key present', () => {
    beforeEach(() => {
      process.env.BRAVE_API_KEY = 'test-key';
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
