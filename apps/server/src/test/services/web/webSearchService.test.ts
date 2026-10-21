import { webSearch, type SearchResult } from '../../../main/services/web/webSearchService';
import { muteConsoleError } from '../../muteConsole';

const consoleErrorSpy = muteConsoleError();

const realFetch = global.fetch;

afterAll(() => {
  consoleErrorSpy.mockRestore();
  global.fetch = realFetch;
});

describe('Web Search Service', () => {
  const originalSearchKey = process.env.BRAVE_SEARCH_API_KEY;

  beforeEach(() => {
    consoleErrorSpy.mockClear();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env.BRAVE_SEARCH_API_KEY = originalSearchKey;
  });

  describe('cleans degradation when the key is unset', () => {
    it('returns [] without calling the API when no key is set', async () => {
      delete process.env.BRAVE_SEARCH_API_KEY;
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      await expect(webSearch('anything')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns [] when BRAVE_SEARCH_API_KEY is an empty string', async () => {
      process.env.BRAVE_SEARCH_API_KEY = '';
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      await expect(webSearch('anything')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('with a key present', () => {
    beforeEach(() => {
      process.env.BRAVE_SEARCH_API_KEY = 'test-key';
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

    it('throws (for the tool wrapper to degrade) on non-ok HTTP responses', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
      await expect(webSearch('q')).rejects.toThrow('Brave search HTTP 429');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('throws on network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
      await expect(webSearch('q')).rejects.toThrow('offline');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('throws on a malformed JSON body (#82: the tool degrades, the service fails loudly)', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('invalid JSON')) });
      await expect(webSearch('q')).rejects.toThrow('invalid JSON');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('does not hit the API for a blank query even with a key', async () => {
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
