import { User, UserDocument } from '../models/User';

// Country-level geolocation; only country + countryCode ever persist.
// @see #50

export interface CoarseLocation {
  country: string;
  countryCode: string;
}

const COUNTRY_IS_URL = 'https://api.country.is/';

// Short per-provider timeout so a hung lookup cannot stall a request.
const PROVIDER_TIMEOUT_MS = 2000;

// Re-resolve at most once per user per week.
// @see #50
const RESOLVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// In-process cooldown after a failed lookup suppresses repeat attempts.
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

// Last failed resolve per user; successes go to Mongo instead. Entries are
// pruned opportunistically so a user who never succeeds cannot pin memory.
const failureCooldown = new Map<string, number>();

const pruneCooldowns = (now = Date.now()): void => {
  for (const [key, at] of failureCooldown) {
    if (now - at >= FAILURE_COOLDOWN_MS) failureCooldown.delete(key);
  }
};

// Accept 2-letter ASCII in any case; normalized at the boundary.
const TWO_LETTER_CODE_ANY_CASE = /^[A-Za-z]{2}$/;

const privateRanges: [string, string][] = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
];

const v4ToLong = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
};

const rangeContains = (ip: string, range: [string, string]): boolean => {
  const value = v4ToLong(ip);
  if (value === null) return false;
  const lo = v4ToLong(range[0]);
  const hi = v4ToLong(range[1]);
  if (lo === null || hi === null) return false;
  return value >= lo && value <= hi;
};

// Local/private/unparsable addresses resolve as "private" for dev and CI.
export const isPrivateIp = (ip: string | undefined): boolean => {
  if (!ip || typeof ip !== 'string') return true;
  const trimmed = ip.trim();
  if (!trimmed) return true;
  if (
    trimmed === '::1' ||
    trimmed === '::' ||
    trimmed.startsWith('fe80:') ||
    trimmed.startsWith('fc') ||
    trimmed.startsWith('fd')
  ) {
    return true;
  }
  // IPv4-mapped IPv6 — check the embedded v4 part.
  const v4 = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (v4.includes(':')) {
    // Other IPv6: non-private so public v6 clients geo resolve.
    return false;
  }
  return privateRanges.some((range) => rangeContains(v4, range));
};

const fetchProvider = async (
  url: string,
  pick: (data: Record<string, unknown>) => CoarseLocation | null,
): Promise<CoarseLocation | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return pick(data);
  } catch (_err) {
    return null;
  }
};

// Primary: country.is — the echoed IP must match, guarding proxies.
const resolveCountryIs = (ip: string | undefined): Promise<CoarseLocation | null> =>
  fetchProvider(COUNTRY_IS_URL, (data) => {
    if (typeof data.ip !== 'string' || data.ip !== ip) return null;
    if (typeof data.country !== 'string' || !TWO_LETTER_CODE_ANY_CASE.test(data.country.trim())) {
      return null;
    }
    const code = data.country.trim().toUpperCase();
    return { country: code, countryCode: code };
  });

// Never throws: every failure mode collapses to `null`. The http-only
// ip-api.com fallback is gone on purpose — it echoes the user's IP in
// cleartext, which is the exact datum being resolved.
// @see #397 #50
export const resolveCountry = async (ip: string | undefined): Promise<CoarseLocation | null> => {
  if (isPrivateIp(ip)) return null;
  return resolveCountryIs(ip);
};

const isFresh = (location: UserDocument['location']): boolean =>
  Boolean(
    location?.resolvedAt &&
    Date.now() - new Date(location.resolvedAt).getTime() < RESOLVE_INTERVAL_MS,
  );

// Single entry point: resolve only when missing/stale, persist on success.
// @see #50
export const ensureUserLocation = async (
  user: UserDocument,
  ip: string | undefined,
): Promise<void> => {
  try {
    const userId = user._id as { toString(): string };
    const key = userId.toString();
    if (user.location?.country && isFresh(user.location)) return;

    const lastFailure = failureCooldown.get(key);
    if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) return;

    const resolved = await resolveCountry(ip);
    if (!resolved) {
      pruneCooldowns();
      failureCooldown.set(key, Date.now());
      return;
    }
    failureCooldown.delete(key);

    const resolvedAt = new Date();
    const location = {
      country: resolved.country,
      countryCode: resolved.countryCode,
      resolvedAt,
    };
    await User.updateOne({ _id: user._id }, { $set: { location } });
    user.location = location;
  } catch (err) {
    console.error('Geo location resolve failed (non-fatal):', err);
  }
};

export const RESET_GEO_COOLDOWN_FOR_TESTS = (): void => {
  failureCooldown.clear();
};
