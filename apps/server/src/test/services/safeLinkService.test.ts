import { checkUrl, isCheckerEnabled } from '../../main/services/safeLinkService';
import { SafeBrowsingCache } from '../../main/models/SafeBrowsingCache';
import { muteConsoleWarn } from '../muteConsole';

const consoleWarnSpy = muteConsoleWarn();

const realFetch = global.fetch;

const KEY_ENV = 'GOOGLE_SAFE_BROWSING_API_KEY';

const matchesResponse = (types: string[]) => ({
  ok: true,
  json: () => Promise.resolve({ matches: types.map((t) => ({ threatType: t })) }),
});

const emptyResponse = () => ({
  ok: true,
  json: () => Promise.resolve({}),
});

afterAll(() => {
  consoleWarnSpy.mockRestore();
  global.fetch = realFetch;
  delete process.env[KEY_ENV];
  delete process.env.GOOGLE_API_KEY;
});

describe('Safe Link Service', () => {
  beforeEach(() => {
    consoleWarnSpy.mockClear();
    global.fetch = jest.fn();
    delete process.env[KEY_ENV];
    delete process.env.GOOGLE_API_KEY;
  });

  describe('key gating', () => {
    it('is disabled with no key of either name', async () => {
      expect(isCheckerEnabled()).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
      await expect(checkUrl('https://example.com/x')).resolves.toEqual({
        enabled: false,
        safe: true,
        source: 'disabled',
      });
    });

    it('reads the primary key name first', () => {
      process.env[KEY_ENV] = 'k-primary';
      process.env.GOOGLE_API_KEY = 'k-generic';
      expect(isCheckerEnabled()).toBe(true);
    });

    it('falls back to the generic GOOGLE_API_KEY', () => {
      delete process.env[KEY_ENV];
      process.env.GOOGLE_API_KEY = 'k-generic';
      expect(isCheckerEnabled()).toBe(true);
    });
  });

  describe('enabled checks', () => {
    beforeEach(() => {
      process.env[KEY_ENV] = 'k-test';
    });

    it('reports safe when matches is empty (API source)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await expect(checkUrl('https://example.com/page')).resolves.toEqual({
        enabled: true,
        safe: true,
        source: 'api',
      });
    });

    it('reports unsafe with threat types when matches is non-empty', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(matchesResponse(['SOCIAL_ENGINEERING']));
      await expect(checkUrl('https://phish.example.net/login')).resolves.toEqual({
        enabled: true,
        safe: false,
        source: 'api',
        threats: ['SOCIAL_ENGINEERING'],
      });
    });

    it('sends the v4 threatMatches body with the full URL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await checkUrl('https://example.com/a?b=c');
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url.startsWith('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=')).toBe(
        true,
      );
      const body = JSON.parse(init.body);
      expect(body.threatInfo.threatEntries).toEqual([{ url: 'https://example.com/a?b=c' }]);
      expect(body.threatInfo.threatEntryTypes).toEqual(['URL']);
      expect(body.client.clientId).toBe('tova-agent');
    });

    it('hits the URL cache on a repeat check without an extra API call (#397)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(matchesResponse(['MALWARE']));
      await expect(checkUrl('https://baddie.example.com/x')).resolves.toMatchObject({
        safe: false,
        source: 'api',
      });
      await expect(checkUrl('https://baddie.example.com/x')).resolves.toMatchObject({
        safe: false,
        source: 'cache',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('never widens a verdict across paths on the same host (#397)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await checkUrl('https://goodie.example.com/a');
      // A different path on the same host re-checks: no shared-host green light.
      (global.fetch as jest.Mock).mockResolvedValue(matchesResponse(['MALWARE']));
      await expect(checkUrl('https://goodie.example.com/b')).resolves.toMatchObject({
        safe: false,
        source: 'api',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('caches safe verdicts per URL too', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await checkUrl('https://goodie.example.com/a?b=c');
      await expect(checkUrl('https://goodie.example.com/a?b=c')).resolves.toMatchObject({
        safe: true,
        source: 'cache',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache degradation (Mongo failure must not green-light a flagged URL)', () => {
    beforeEach(() => {
      process.env[KEY_ENV] = 'k-test';
    });

    it('falls through to the API when the cache read fails', async () => {
      const findOneSpy = jest
        .spyOn(SafeBrowsingCache, 'findOne')
        .mockImplementation(
          () => ({ lean: () => Promise.reject(new Error('mongo down')) }) as never,
        );
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await expect(checkUrl('https://example.com/db-outage')).resolves.toMatchObject({
        enabled: true,
        safe: true,
        source: 'api',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      findOneSpy.mockRestore();
    });

    it('still consults the API and enforces unsafe even if cache read fails', async () => {
      const findOneSpy = jest
        .spyOn(SafeBrowsingCache, 'findOne')
        .mockImplementation(
          () => ({ lean: () => Promise.reject(new Error('mongo down')) }) as never,
        );
      (global.fetch as jest.Mock).mockResolvedValue(matchesResponse(['MALWARE']));
      await expect(checkUrl('https://flagged.example.com/x')).resolves.toMatchObject({
        enabled: true,
        safe: false,
        source: 'api',
      });
      findOneSpy.mockRestore();
    });

    it('enforces the unsafe verdict even when the cache write fails', async () => {
      const updateOneSpy = jest
        .spyOn(SafeBrowsingCache, 'updateOne')
        .mockRejectedValue(new Error('mongo down'));
      (global.fetch as jest.Mock).mockResolvedValue(matchesResponse(['SOCIAL_ENGINEERING']));
      await expect(checkUrl('https://phish.example.org/steal')).resolves.toMatchObject({
        enabled: true,
        safe: false,
        source: 'api',
        threats: ['SOCIAL_ENGINEERING'],
      });
      updateOneSpy.mockRestore();
    });

    it('still reports safe from the API when the cache write fails', async () => {
      const updateOneSpy = jest
        .spyOn(SafeBrowsingCache, 'updateOne')
        .mockRejectedValue(new Error('mongo down'));
      (global.fetch as jest.Mock).mockResolvedValue(emptyResponse());
      await expect(checkUrl('https://fine.example.org/ok')).resolves.toMatchObject({
        enabled: true,
        safe: true,
        source: 'api',
      });
      updateOneSpy.mockRestore();
    });
  });

  describe('fail-open on API errors', () => {
    beforeEach(() => {
      process.env[KEY_ENV] = 'k-test';
    });

    it('proceeds (unchecked) on a 5xx and does not cache the miss', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
      await expect(checkUrl('https://example.com/flaky')).resolves.toMatchObject({
        enabled: true,
        safe: true,
        source: 'unchecked',
      });
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('proceeds (unchecked) when fetch rejects (network/timeout)', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('This operation was aborted'));
      await expect(checkUrl('https://example.com/hang')).resolves.toMatchObject({
        enabled: true,
        safe: true,
        source: 'unchecked',
      });
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });
});
