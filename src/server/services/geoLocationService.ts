import { User, UserDocument } from '../models/User';

// Coarse, country-level geolocation (issue #50). Only country + countryCode
// are ever extracted from a provider payload and persisted; everything else
// (city, lat/lon, ISP, …) is dropped at parse time and never leaves this
// module. Both providers failing degrades to `null` — chat never depends on
// this succeeding.

export interface CoarseLocation {
  country: string;
  countryCode: string;
}

const COUNTRY_IS_URL = 'https://api.country.is/';
const IP_API_URL = 'http://ip-api.com/json/?fields=country,countryCode';

// Short per-provider timeout so a hung lookup cannot stall a request.
const PROVIDER_TIMEOUT_MS = 2000;

// Re-resolve at most once per user per week (ticket #50).
const RESOLVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// After a failed lookup, don't hammer the providers on every request: an
// in-process cooldown suppresses repeats for this long (Mongo is NOT written
// on failure, so a success right after a transient outage still lands).
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

// userId -> timestamp of the last failed resolve attempt. Never stores
// successes (a success goes to Mongo); write-only growth of one entry per
// user is acceptable at this scale.
const failureCooldown = new Map<string, number>();

// Providers occasionally vary case (ip-api is uppercase, but lowercase inputs
// are normalized below): accept 2-letter ASCII, normalize at the boundary.
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

// Empty / unparsable / local / private / link-local addresses resolve as
// "private" so dev and CI (localhost, docker bridge IPs) never hit live
// geolocation providers.
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
  // IPv4-mapped IPv6 (::ffff:10.0.0.7) — check the embedded v4 part.
  const v4 = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (v4.includes(':')) {
    // Any other IPv6 address: treat as non-private so public v6 clients geo
    // resolve; known-link-local/ULA prefixes are caught above.
    return false;
  }
  return privateRanges.some((range) => rangeContains(v4, range));
};

const isCoarseLocation = (value: unknown): value is CoarseLocation => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.country === 'string' &&
    candidate.country.trim().length > 0 &&
    typeof candidate.countryCode === 'string' &&
    TWO_LETTER_CODE_ANY_CASE.test(candidate.countryCode.trim())
  );
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

// Primary: country.is — {ip, country} with `country` the 2-letter code. The
// IP is echoed back in the response; requiring a match defends against a
// wrong/proxied answer for the requested address.
const resolveCountryIs = (ip: string | undefined): Promise<CoarseLocation | null> =>
  fetchProvider(COUNTRY_IS_URL, (data) => {
    if (typeof data.ip !== 'string' || data.ip !== ip) return null;
    if (typeof data.country !== 'string' || !TWO_LETTER_CODE_ANY_CASE.test(data.country.trim())) {
      return null;
    }
    const code = data.country.trim().toUpperCase();
    return { country: code, countryCode: code };
  });

// Fallback: ip-api.com — keep only country/countryCode even though the API
// returns more; the narrow type is what bounds what can be persisted.
const resolveIpApi = (): Promise<CoarseLocation | null> =>
  fetchProvider(IP_API_URL, (data) => {
    if (!isCoarseLocation(data)) return null;
    return {
      country: String(data.country).trim(),
      countryCode: String(data.countryCode).trim().toUpperCase(),
    };
  });

// Never throws: every failure mode collapses to `null`.
export const resolveCountry = async (ip: string | undefined): Promise<CoarseLocation | null> => {
  if (isPrivateIp(ip)) return null;
  return (await resolveCountryIs(ip)) ?? (await resolveIpApi());
};

const isFresh = (location: UserDocument['location']): boolean =>
  Boolean(
    location?.resolvedAt &&
    Date.now() - new Date(location.resolvedAt).getTime() < RESOLVE_INTERVAL_MS,
  );

// Single entry point for call sites: read cached state off the user doc,
// resolve only when missing or stale, and persist a successful result.
// Resolves in place on the passed document so the same request can build the
// chat prompt from it without a second Mongo read. Failure paths return
// silently (no Mongo write, no throw) — chat must never block on geo.
// `ip` may be undefined: Express types req.ip accordingly and the private-IP
// guard treats a missing IP as unresolvable.
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
