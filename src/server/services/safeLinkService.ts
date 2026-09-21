import { redactForLog } from './logRedaction';

import { SafeBrowsingCache } from '../models/SafeBrowsingCache';

// Safe Browsing link checker for `fetch_url` (issue #120): every URL the
// agent fetches (including redirect-hop targets) is screened against
// Google's threatMatches endpoint before a request is made. Uses the SAME
// global fetch as everything else, so tests can stub it.
//
// Key read order: GOOGLE_SAFE_BROWSING_API_KEY, falling back to generic
// GOOGLE_API_KEY (which name the user's provisioned key lands under is not
// yet fixed; supporting both is free). Both absent → checker disabled:
// fetch_url proceeds unchanged, mirroring the BRAVE_SEARCH_API_KEY
// precedent (#16).
//
// Failure posture: API errors fail OPEN (proceed) but loudly — a checker
// outage must not brick fetch_url. This is the plan's named, deliberate
// call; switching to fail-closed is a one-line change if the user prefers
// strictness.

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

// Hard cap so a hung Google call cannot stall a fetch.
const CHECK_TIMEOUT_MS = 4_000;

const THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION',
];

export type CheckSource = 'api' | 'cache' | 'disabled' | 'unchecked';

export interface SafeLinkVerdict {
  enabled: boolean;
  safe: boolean;
  source: CheckSource;
  // Populated when safe=false: the threat types Google reported.
  threats?: string[];
}

export const safeBrowsingApiKey = (): string | undefined =>
  process.env.GOOGLE_SAFE_BROWSING_API_KEY || process.env.GOOGLE_API_KEY || undefined;

export const isCheckerEnabled = (): boolean => safeBrowsingApiKey() !== undefined;

const warnOutage = (url: string, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    'Safe Browsing check failed for %s, proceeding (fail-open): %O',
    redactForLog(url),
    redactForLog(message),
  );
};

const callThreatMatches = async (url: string, apiKey: string): Promise<string[]> => {
  const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client: { clientId: 'tova-agent', clientVersion: '1.0.0' },
      threatInfo: {
        threatTypes: THREAT_TYPES,
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url }],
      },
    }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Safe Browsing HTTP ${response.status}`);
  const data = (await response.json()) as { matches?: Array<{ threatType?: string }> };
  return (data.matches ?? []).flatMap((m) =>
    typeof m.threatType === 'string' ? [m.threatType] : [],
  );
};

const cacheKey = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

// A cache-read failure is recoverable: fall through to the live API call
// instead of reporting the URL unchecked.
const readCache = async (host: string): Promise<string | null> => {
  try {
    const entry = await SafeBrowsingCache.findOne({ host }).lean<{ verdict?: string }>();
    return entry?.verdict ?? null;
  } catch (err) {
    warnOutage(`cache read for ${host}`, err);
    return null;
  }
};

const writeCache = async (host: string, verdict: 'safe' | 'unsafe'): Promise<void> => {
  try {
    await SafeBrowsingCache.updateOne(
      { host },
      { verdict, checkedAt: new Date() },
      { upsert: true },
    );
  } catch (err) {
    warnOutage(`cache write for ${host}`, err);
  }
};

// Screens a URL. Never throws: only API-call errors report safe=true with
// source='unchecked' (fail-open); a Mongo cache failure is degraded to
// losing the cache — the authoritative API verdict is still enforced, so a
// database outage can never green-light a URL Google flagged.
// Returns { enabled: false } when no key is configured — callers proceed.
export const checkUrl = async (url: string): Promise<SafeLinkVerdict> => {
  const apiKey = safeBrowsingApiKey();
  if (!apiKey) return { enabled: false, safe: true, source: 'disabled' };
  const host = cacheKey(url);
  if (host) {
    const verdict = await readCache(host);
    if (verdict === 'unsafe') return { enabled: true, safe: false, source: 'cache' };
    if (verdict === 'safe') return { enabled: true, safe: true, source: 'cache' };
  }
  try {
    const threats = await callThreatMatches(url, apiKey);
    if (host) await writeCache(host, threats.length > 0 ? 'unsafe' : 'safe');
    if (threats.length > 0) {
      return { enabled: true, safe: false, source: 'api', threats };
    }
    return { enabled: true, safe: true, source: 'api' };
  } catch (err) {
    warnOutage(url, err);
    return { enabled: true, safe: true, source: 'unchecked' };
  }
};

// Throws a caller-renderable error when the URL is known-unsafe; a no-op
// when the checker is disabled or the verdict is safe/unchecked.
export const assertSafeUrl = async (url: string): Promise<void> => {
  const verdict = await checkUrl(url);
  if (!verdict.enabled || verdict.safe) return;
  const threats = verdict.threats?.length ? ` (${verdict.threats.join(', ')})` : '';
  throw new Error(
    `link blocked by Safe Browsing: ${url} reports ${verdict.source} verdict${threats}`,
  );
};
