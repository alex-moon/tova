import { User } from '../../../main/models/User';
import {
  ensureUserLocation,
  isPrivateIp,
  resolveCountry,
  RESET_GEO_COOLDOWN_FOR_TESTS,
} from '../../../main/services/web/geoLocationService';
import { UserDocument } from '../../../main/models/User';

import { muteConsoleError } from '../../muteConsole';

const consoleErrorSpy = muteConsoleError();

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
  // Spy history repeats; clear it so a stale call cannot contaminate this one.
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

  it('returns null (never throws) when country.is fails (#397: no http fallback)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    await expect(resolveCountry('8.8.8.8')).resolves.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when country.is returns a bad shape', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(okJson({ ip: '8.8.8.8', country: 'FRA' }));
    await expect(resolveCountry('8.8.8.8')).resolves.toBeNull();
  });

  it('treats a non-ok provider status as failure', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(resolveCountry('8.8.8.8')).resolves.toBeNull();
  });

  it('sends the user IP only over https (no plaintext geo fallback, #397)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    await resolveCountry('8.8.8.8');
    for (const [url] of (global.fetch as jest.Mock).mock.calls) {
      expect(String(url).startsWith('https://')).toBe(true);
    }
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
    // A failed resolve tries the one https provider; the second call cooldowns out.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('retries after the cooldown expires (time travel)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    Date.now = () => realNow() + 2 * 60 * 60 * 1000;
    await ensureUserLocation(user, '8.8.8.8');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('a failure followed by a cooldown-window success still resolves', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(okJson({ ip: '8.8.8.8', country: 'FI' }));
    const user = userWith();
    await ensureUserLocation(user, '8.8.8.8');
    // Simulate a second request process (no shared in-process cooldown).
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
    global.fetch = jest.fn().mockResolvedValueOnce(
      okJson({
        ip: '8.8.8.8',
        country: 'FI',
        city: 'Helsinki',
        isp: 'x',
      }),
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
