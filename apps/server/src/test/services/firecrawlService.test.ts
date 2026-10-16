import dns from 'dns';
import { firecrawlScrape } from '../../main/services/firecrawlService';

// #340: the Firecrawl fallback scraper. The Safe Browsing checker is stubbed
// here (its own unit tests live in safeLinkService.test.ts); DNS and global
// fetch are mocked so the request shape and error mapping are testable.
const mockAssertSafeUrl = jest.fn<Promise<void>, [string]>();

jest.mock('../../main/services/safeLinkService', () => ({
  assertSafeUrl: (url: string) => mockAssertSafeUrl(url),
}));

const realFetch = global.fetch;
const realLookup = dns.promises.lookup;

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

afterAll(() => {
  global.fetch = realFetch;
  dns.promises.lookup = realLookup;
  delete process.env.FIRECRAWL_API_KEY;
});

describe('firecrawlScrape (#340)', () => {
  beforeEach(() => {
    mockAssertSafeUrl.mockReset().mockResolvedValue(undefined);
    global.fetch = jest.fn();
    dns.promises.lookup = jest.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;
    process.env.FIRECRAWL_API_KEY = 'fc-test';
  });

  it('returns null (no fallback) when no key is configured', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    expect(await firecrawlScrape('https://example.com')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a successful scrape to a FetchedPage and sends the right request', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          markdown: '# Hi\n\nbody',
          metadata: { title: 'Hi', sourceURL: 'https://example.com/final' },
        },
      }),
    );
    const page = await firecrawlScrape('https://example.com');
    expect(page).toEqual({
      url: 'https://example.com/final',
      title: 'Hi',
      content: '# Hi\n\nbody',
    });
    const [endpoint, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(endpoint).toBe('https://api.firecrawl.dev/v2/scrape');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fc-test');
    expect(JSON.parse(init.body)).toMatchObject({
      url: 'https://example.com/',
      formats: ['markdown'],
    });
    expect(mockAssertSafeUrl).toHaveBeenCalledWith('https://example.com/');
  });

  it('falls back to the hostname when the scrape has no title', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ success: true, data: { markdown: 'body' } }),
    );
    const page = await firecrawlScrape('https://example.com/x');
    expect(page).toMatchObject({ title: 'example.com', content: 'body' });
  });

  it('throws on a non-2xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, 402));
    await expect(firecrawlScrape('https://example.com')).rejects.toThrow('firecrawl HTTP 402');
  });

  it('throws when the scrape returns no markdown', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ success: true, data: {} }));
    await expect(firecrawlScrape('https://example.com')).rejects.toThrow('no markdown');
  });

  it('rejects a non-http scheme before any network call', async () => {
    await expect(firecrawlScrape('file:///etc/passwd')).rejects.toThrow('unsupported URL scheme');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a host resolving to a private address before any network call', async () => {
    dns.promises.lookup = jest.fn(async () => [
      { address: '127.0.0.1', family: 4 },
    ]) as unknown as typeof dns.promises.lookup;
    await expect(firecrawlScrape('http://localhost')).rejects.toThrow('refusing to fetch');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
