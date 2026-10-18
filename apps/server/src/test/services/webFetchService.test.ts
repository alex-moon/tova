import dns from 'dns';
import { fetchPage } from '../../main/services/webFetchService';
import { muteConsoleError } from '../muteConsole';

// Safe Browsing is a controllable stub here (unit tests in safeLinkService).
const mockAssertSafeUrl = jest.fn<Promise<void>, [string]>();

jest.mock('../../main/services/safeLinkService', () => ({
  assertSafeUrl: (url: string) => mockAssertSafeUrl(url),
}));

const consoleErrorSpy = muteConsoleError();

const realFetch = global.fetch;
const realLookup = dns.promises.lookup;

const okResponse = (body: string, contentType = 'text/html; charset=utf-8') => ({
  ok: true,
  body: {},
  headers: new Headers({ 'content-type': contentType }),
  text: () => Promise.resolve(body),
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  global.fetch = realFetch;
  dns.promises.lookup = realLookup;
});

describe('Web Fetch Service', () => {
  beforeEach(() => {
    consoleErrorSpy.mockClear();
    mockAssertSafeUrl.mockReset().mockResolvedValue(undefined);
    global.fetch = jest.fn();
    dns.promises.lookup = jest.fn() as unknown as typeof dns.promises.lookup;
  });

  describe('scheme and URL validation', () => {
    it('rejects file: URLs before any network or DNS work', async () => {
      await expect(fetchPage('file:///etc/passwd')).rejects.toThrow('unsupported URL scheme');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects data: and javascript: URLs', async () => {
      await expect(fetchPage('data:text/html,hi')).rejects.toThrow('unsupported URL scheme');
      await expect(fetchPage('javascript:alert(1)')).rejects.toThrow('unsupported URL scheme');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects unparsable URLs', async () => {
      await expect(fetchPage('not a url')).rejects.toThrow('invalid URL');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('SSRF refusal', () => {
    it('refuses private IP literals without resolving DNS', async () => {
      await expect(fetchPage('http://127.0.0.1/x')).rejects.toThrow('private address');
      await expect(fetchPage('http://10.1.2.3/x')).rejects.toThrow('private address');
      await expect(fetchPage('http://192.168.0.9/x')).rejects.toThrow('private address');
      await expect(fetchPage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
        'private address',
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses IPv4-mapped IPv6 literals (hex, as URL normalizes them)', async () => {
      await expect(fetchPage('http://[::ffff:10.0.0.7]/x')).rejects.toThrow('private address');
      await expect(fetchPage('http://[::ffff:a00:7]/x')).rejects.toThrow('private address');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses other private IPv6 literals (loopback, link-local, ULA)', async () => {
      await expect(fetchPage('http://[fe80::1]/x')).rejects.toThrow('private address');
      await expect(fetchPage('http://[fd12::1]/x')).rejects.toThrow('private address');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses localhost resolving to loopback (real pasted-URL case)', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(fetchPage('http://localhost:3000/admin')).rejects.toThrow(
        'resolving to a private address',
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses hostnames that resolve to a private address', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
      await expect(fetchPage('http://rebind.example.com/x')).rejects.toThrow(
        'resolving to a private address',
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses unresolvable hostnames', async () => {
      (dns.promises.lookup as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));
      await expect(fetchPage('http://nope.invalid/x')).rejects.toThrow('unresolvable host');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('successful fetches', () => {
    it('converts HTML to markdown and extracts the title', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse(
          '<html><head><title>Hello Page</title></head><body><h1>Hi</h1><p>Body.</p></body></html>',
        ),
      );
      await expect(fetchPage('https://example.com/post')).resolves.toMatchObject({
        title: 'Hello Page',
        content: expect.stringContaining('Hi'),
      });
      await expect(fetchPage('https://example.com/post')).resolves.toMatchObject({
        title: 'Hello Page',
        content: expect.stringMatching(/# Hi[\s\S]*Body\./),
      });
    });

    it('falls back to the URL as title when the HTML has no <title>', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse('<html><body><p>Just text.</p></body></html>'),
      );
      await expect(fetchPage('https://example.com/plain')).resolves.toMatchObject({
        title: 'https://example.com/plain',
        content: 'Just text.',
      });
    });

    it('passes text/plain through as-is', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      (global.fetch as jest.Mock).mockResolvedValue(okResponse('plain text body', 'text/plain'));
      await expect(fetchPage('https://example.com/raw.txt')).resolves.toMatchObject({
        title: 'https://example.com/raw.txt',
        content: 'plain text body',
      });
    });

    it('passes application/json through as-is', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse('{"key":"value"}', 'application/json'),
      );
      await expect(fetchPage('https://example.com/api')).resolves.toMatchObject({
        title: 'https://example.com/api',
        content: '{"key":"value"}',
      });
    });
  });

  describe('capping and failure paths', () => {
    const publicHost = () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
    };

    it('drops an oversized hit early when content-length exceeds the cap', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValue({
        ...okResponse('unused'),
        headers: new Headers({ 'content-type': 'text/plain', 'content-length': '999999999' }),
      });
      await expect(fetchPage('https://example.com/big')).rejects.toThrow('too large');
    });

    it('rejects non-2xx responses with the status', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
      await expect(fetchPage('https://example.com/forbidden')).rejects.toThrow('HTTP 403');
    });

    it('rejects fetch errors (timeouts, refused connections)', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('This operation was aborted'));
      await expect(fetchPage('https://example.com/slow')).rejects.toThrow('fetch failed');
    });

    it('rejects empty bodies', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValue(okResponse('   ', 'text/plain'));
      await expect(fetchPage('https://example.com/empty')).rejects.toThrow('empty response body');
    });

    it('rejects unsupported content types by returning null', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValue(
        okResponse('\x1f\x8b\x08', 'application/octet-stream'),
      );
      await expect(fetchPage('https://example.com/bin')).resolves.toBeNull();
    });
  });

  describe('redirect handling', () => {
    const publicHost = () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
    };
    const redirectResponse = (location: string) => ({
      ok: false,
      status: 302,
      headers: new Headers({ location }),
      body: {},
      text: () => Promise.resolve(''),
    });

    it('follows redirects and re-checks each hop', async () => {
      publicHost();
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(redirectResponse('https://moved.example.com/finally'))
        .mockResolvedValueOnce(okResponse('<html><title>Found</title></html>'));
      await expect(fetchPage('https://example.com/here')).resolves.toEqual(
        expect.objectContaining({ title: 'Found' }),
      );
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
        'https://moved.example.com/finally',
      );
    });

    it('refuses a redirect whose target host resolves to a private address', async () => {
      // One check for the original host (hop 0), then one for the redirect.
      (dns.promises.lookup as jest.Mock)
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }]);
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        redirectResponse('http://intranet.example.com/here'),
      );
      await expect(fetchPage('https://example.com/rebind')).rejects.toThrow('private address');
      // The redirect was followed; only the target check refused, once.
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://example.com/rebind');
      expect((dns.promises.lookup as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
        'example.com',
        'intranet.example.com',
      ]);
    });

    it('refuses a redirect to a private IP literal without any DNS lookup', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValueOnce(redirectResponse('http://10.0.0.7/here'));
      await expect(fetchPage('https://example.com/rebind')).rejects.toThrow('private address');
      expect(dns.promises.lookup as jest.Mock).not.toHaveBeenCalledWith('10.0.0.7');
      expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('refuses a redirect to a non-http scheme', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValueOnce(redirectResponse('file:///etc/passwd'));
      await expect(fetchPage('https://example.com/escape')).rejects.toThrow(
        'unsupported redirect scheme',
      );
    });

    it('gives up after too many redirects', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockImplementation(() =>
        Promise.resolve(redirectResponse('/next-hop')),
      );
      await expect(fetchPage('https://example.com/loop')).rejects.toThrow('too many redirects');
      expect(global.fetch).toHaveBeenCalledTimes(6);
    });

    it('rejects a 3xx response with no location header', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValueOnce(redirectResponse(''));
      await expect(fetchPage('https://example.com/lost')).rejects.toThrow('no location header');
    });
  });

  describe('safe link checking (#120, checker stubbed)', () => {
    const publicHost = () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
    };
    const redirectResponse = (location: string) => ({
      ok: false,
      status: 302,
      headers: new Headers({ location }),
      body: {},
      text: () => Promise.resolve(''),
    });

    it('refuses the initial URL before any page fetch when unsafe', async () => {
      publicHost();
      mockAssertSafeUrl.mockRejectedValue(
        new Error(
          'link blocked by Safe Browsing: https://phish.example.com/x (SOCIAL_ENGINEERING)',
        ),
      );
      await expect(fetchPage('https://phish.example.com/x')).rejects.toThrow('link blocked');
      expect(global.fetch).not.toHaveBeenCalled();
      // Screened once, for the initial URL.
      expect(mockAssertSafeUrl).toHaveBeenCalledWith('https://phish.example.com/x');
    });

    it('screens the initial URL and then each redirect hop', async () => {
      publicHost();
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(redirectResponse('https://moved.example.com/finally'))
        .mockResolvedValueOnce(okResponse('<html><title>ok</title></html>'));
      await fetchPage('https://example.com/hop-chain');
      expect(mockAssertSafeUrl.mock.calls.map((c) => c[0])).toEqual([
        // Hop 0 is the initial URL; screened once, not twice.
        'https://example.com/hop-chain',
        'https://moved.example.com/finally',
      ]);
    });

    it('blocks a redirect whose hop target is flagged', async () => {
      publicHost();
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        redirectResponse('https://bait.example.com/final'),
      );
      mockAssertSafeUrl.mockImplementation((url) =>
        url.includes('bait.example.com')
          ? Promise.reject(new Error(`link blocked by Safe Browsing: ${url}`))
          : Promise.resolve(),
      );
      await expect(fetchPage('https://example.com/redirects-bad')).rejects.toThrow('link blocked');
      expect(global.fetch).toHaveBeenCalledTimes(1); // bait page never fetched
    });
  });

  describe('surrogate-safe truncation', () => {
    it('does not split an emoji pair straddling the 8k cut', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      // 'a' x7999 puts the surrogate pair exactly on the 8000-char boundary.
      const body = 'a'.repeat(7_999) + '😀';
      (global.fetch as jest.Mock).mockResolvedValue(okResponse(body, 'text/plain'));
      const page = await fetchPage('https://example.com/emoji');
      expect(page?.content.length).toBe(7_999);
      expect(page?.content).not.toMatch(/[\uD800-\uDFFF]/); // no lone surrogates
      expect(page?.content.startsWith('a')).toBe(true);
    });
  });

  describe('streaming size cap', () => {
    it('stops reading a body that streams past the cap', async () => {
      (dns.promises.lookup as jest.Mock).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);
      const encoder = new TextEncoder();
      let cancelled = false;
      const infiniteStream = {
        getReader: () => ({
          read: () => Promise.resolve({ done: false, value: encoder.encode('x'.repeat(10_000)) }),
          cancel: jest.fn(() => {
            cancelled = true;
            return Promise.resolve();
          }),
        }),
        cancel: undefined,
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ...okResponse('unused'),
        body: infiniteStream,
      });
      const page = await fetchPage('https://example.com/eternal');
      expect(page?.content).toHaveLength(8_000);
      expect(cancelled).toBe(true); // stream cancelled as soon as the cap was hit
    });
  });
});
