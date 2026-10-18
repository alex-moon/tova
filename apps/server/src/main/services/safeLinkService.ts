import { redactForLog } from './logRedaction';

import { SafeBrowsingCache } from '../models/SafeBrowsingCache';

// Safe Browsing link checker for fetch_url; API errors fail open but loudly.
// @see #120 #16

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
    // Full-URL key: a host-level verdict would green-light unrelated paths.
    // @see #397
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

// A cache-read failure falls through to the live API call.
const readCache = async (url: string): Promise<string | null> => {
  try {
    const entry = await SafeBrowsingCache.findOne({ url }).lean<{ verdict?: string }>();
    return entry?.verdict ?? null;
  } catch (err) {
    warnOutage(`cache read for ${url}`, err);
    return null;
  }
};

const writeCache = async (url: string, verdict: 'safe' | 'unsafe'): Promise<void> => {
  try {
    await SafeBrowsingCache.updateOne(
      { url },
      { verdict, checkedAt: new Date() },
      { upsert: true },
    );
  } catch (err) {
    warnOutage(`cache write for ${url}`, err);
  }
};

// Screens a URL, never throws; only API errors report unchecked (fail-open).
export const checkUrl = async (url: string): Promise<SafeLinkVerdict> => {
  const apiKey = safeBrowsingApiKey();
  if (!apiKey) return { enabled: false, safe: true, source: 'disabled' };
  const key = cacheKey(url);
  if (key) {
    const verdict = await readCache(key);
    if (verdict === 'unsafe') return { enabled: true, safe: false, source: 'cache' };
    if (verdict === 'safe') return { enabled: true, safe: true, source: 'cache' };
  }
  try {
    const threats = await callThreatMatches(url, apiKey);
    if (key) await writeCache(key, threats.length > 0 ? 'unsafe' : 'safe');
    if (threats.length > 0) {
      return { enabled: true, safe: false, source: 'api', threats };
    }
    return { enabled: true, safe: true, source: 'api' };
  } catch (err) {
    warnOutage(url, err);
    return { enabled: true, safe: true, source: 'unchecked' };
  }
};

// Throws a caller-renderable error when the URL is known-unsafe.
export const assertSafeUrl = async (url: string): Promise<void> => {
  const verdict = await checkUrl(url);
  if (!verdict.enabled || verdict.safe) return;
  const threats = verdict.threats?.length ? ` (${verdict.threats.join(', ')})` : '';
  throw new Error(
    `link blocked by Safe Browsing: ${url} reports ${verdict.source} verdict${threats}`,
  );
};
