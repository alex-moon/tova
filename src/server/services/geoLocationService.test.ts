import { User } from '../models/User';
import {
  ensureUserLocation,
  isPrivateIp,
  resolveCountry,
  RESET_GEO_COOLDOWN_FOR_TESTS,
} from './geoLocationService';
import { UserDocument } from '../models/User';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

const realFetch = global.fetch;
const realNow = Date.now;

const okJson = (body: unknown) => ({
  ok: true,
  json: () => Promise.resolve(body),
});

const userWith = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: 'user-geo-1',
    location: null,
    ...overrides,
  }) as unknown as UserDocument;

beforeEach(() => {
  // Spies repeat across tests through spyOn: clear their history so a
  // stale updateOne call from an earlier case can never contaminate this one.
  jest.resetAllMocks();
  RESET_GEO_COOLDOWN_FOR_TESTS();
  global.fetch = jest.fn();
  jest.spyOn(User, 'updateOne').mockReturnValue({
    exec: () => Promise.resolve({}),
  } as never);
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  global.fetch = realFetch;
  Date.now = realNow;
  jest.restoreAllMocks();
});

describe('isPrivateIp (#50)', () => {
  it('treats empty and unparsable addresses as private (skip resolution)', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('   ')).toBe(true);
    expect(isPrivateIp(undefined as unknown as string)).toBe(true);
  });

  it('skips loopback, private and link-local IPv4 ranges', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    // Just outside the 172.16/12 boundary must NOT be private.
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('skips IPv6 loopback and unique/link-local prefixes', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1234')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });

  it('resolves public IPv4 and IPv6', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('212.84.62.19')).toBe(false);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
  });

  it('checks the embedded IPv4 address in IPv4-mapped IPv6', () => {
    expect(isPrivateIp('::ffff:10.0.0.7')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('resolveCountry provider selection (#50)', () => {
  it('uses country.is and short-circuits on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ ip: '8.8.8.8', country: 'FI' }));
    await expect(resolveCountry('8.8.8.8')).resolves.toEqual({
      country: 'FI',
      countryCode: 'FI',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('https://api.country.is/', expect.anything());
  });

  it('falls back to ip-api when country.is fails', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okJson({ country: 'Finland', countryCode: 'fi' }));
    await expect(resolveCountry('8.8.8.8')).resolves.toEqual({
      country: 'Finland',
      countryCode: 'FI',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns null (never throws) when both providers fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    await expect(resolveCountry('8.8.8.8')).resolves.toBeNull();
  });

  it('returns null when country.is returns a bad shape', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(okJson({ ip: '8.8.8.8', country: 'FRA' }))
      .mockResolvedValueOnce(okJson({ country: 'France', countryCode: 'FR' }));
    await expect(resolveCountry('8.8.8.8')).resolves.toEqual({
      country: 'France',
      countryCode: 'FR',
    });
  });

  it('treats a non-ok provider status as failure', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce(okJson({ country: 'Finland', countryCode: 'FI' }));
    await expect(resolveCountry('8.8.8.8')).resolves.toEqual({
      country: 'Finland',
      countryCode: 'FI',
    });
  });

  it('keeps the answer coarse even though ip-api returns more fields', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('country.is down'))
      .mockResolvedValueOnce(
        okJson({
          country: 'Finland',
          countryCode: 'FI',
          city: 'Helsinki',
          lat: 60.17,
          lon: 24.94,
          isp: 'Some ISP Ltd',
        }),
      );
    await expect(resolveCountry('8.8.8.8')).resolves.toEqual({
      country: 'Finland',
      countryCode: 'FI',
    });
  });

  it('never resolves private or missing IPs against live providers', async () => {
    global.fetch = jest.fn();
    await expect(resolveCountry('192.168.1.10')).resolves.toBeNull();
    await expect(resolveCountry('')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('ensureUserLocation caching (#50)', () => {
  it('does not fetch when the cached location is fresh', async () => {
    const user = userWith({
      location: { country: 'Finland', countryCode: 'FI', resolvedAt: new Date() },
    });
    await ensureUserLocation(user, '8.8.8.8');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('resolves and persists when the location is older than 7 days', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ ip: '8.8.8.8', country: 'FI' }));
    jest.spyOn(User, 'updateOne').mockReturnValue({ exec: () => Promise.resolve({}) } as never);
    const user = userWith({
      location: {
        country: 'Finland',
        countryCode: 'FI',
        resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });
    await ensureUserLocation(user, '8.8.8.8');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'user-geo-1' },
      expect.objectContaining({ $set: expect.anything() }),
    );
    expect(user.location?.country).toBe('FI');
  });

  it('resolves when no location exists yet, and stamps resolvedAt', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ ip: '8.8.8.8', country: 'FI' }));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    expect(user.location?.resolvedAt).toBeInstanceOf(Date);
    expect(Object.keys(user.location ?? {}).sort()).toEqual([
      'country',
      'countryCode',
      'resolvedAt',
    ]);
  });

  it('applies the failure cooldown: two calls in a row fetch once', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    await ensureUserLocation(user, '8.8.8.8');
    // Each failed resolve tries both providers; the second ensure call must
    // short-circuit entirely on the cooldown (no further fetches).
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('retries after the cooldown expires (time travel)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    Date.now = () => realNow() + 2 * 60 * 60 * 1000;
    await ensureUserLocation(user, '8.8.8.8');
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('a failure followed by a cooldown-window success still resolves', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(okJson({ ip: '8.8.8.8', country: 'FI' }));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    // Simulate the retry of a second request process (no shared in-process
    // cooldown): delete + resolve again.
    RESET_GEO_COOLDOWN_FOR_TESTS();
    await ensureUserLocation(user, '8.8.8.8');
    expect(user.location?.countryCode).toBe('FI');
  });

  it('does not fetch when the IP is local even if the cache is missing', async () => {
    global.fetch = jest.fn();
    const user = userWith();
    await ensureUserLocation(user, '127.0.0.1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(user.location).toBeNull();
  });

  it('stores only the three coarse fields', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('country.is down'))
      .mockResolvedValueOnce(
        okJson({ country: 'Finland', countryCode: 'FI', city: 'Helsinki', isp: 'x' }),
      );
    let written: unknown;
    jest.spyOn(User, 'updateOne').mockImplementation((...args: unknown[]) => {
      written = args[1];
      return { exec: () => Promise.resolve({}) } as never;
    });
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    const set = (written as { $set?: { location?: Record<string, unknown> } }).$set?.location;
    expect(Object.keys(set ?? {}).sort()).toEqual(['country', 'countryCode', 'resolvedAt']);
  });
});
