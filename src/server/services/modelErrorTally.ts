import { redactForLog } from './logRedaction';
import { ModelRouteError } from '../models/ModelRouteError';
import { isOverloadError } from './providerErrors';

/*
 * Issue #175: per-provider-route error tally. Every completion call through
 * inferenceService records its failures here: status code, a running count
 * and a coarse category. Categories are heuristics over the error text and
 * HTTP status (AI-SDK errors carry `statusCode`); they are intentionally
 * rough — the unredacted, canonical location for the phrasing of a live
 * error is the persisted error log (errorlogs) written by logService.
 */

export type ModelErrorCategory =
  | 'missing_key'
  | 'invalid_or_expired_key'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'context_length'
  | 'overloaded'
  | 'server_error'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'unknown_provider'
  | 'unknown';

export const CATEGORIES: ModelErrorCategory[] = [
  'missing_key',
  'invalid_or_expired_key',
  'forbidden',
  'not_found',
  'rate_limit',
  'context_length',
  'overloaded',
  'server_error',
  'bad_request',
  'timeout',
  'network',
  'unknown_provider',
  'unknown',
];

// AI-SDK APICallError shape, plus plain Axios-style messages
// ("Request failed with status code 401").
type StatusCarrier = { statusCode?: unknown; status?: unknown };

const STATUS_TEXT = /(?:status|status code|http status)[^\d]{0,20}(\d{3})\b/i;
const ABORT_TEXT = /\babort(ed)?\b|\btimed?\s?out\b|\bdeadline\b/i;
const NETWORK_TEXT =
  /\b(econnrefused|econnreset|econnaborted|etimedout|enotfound|eai_again|ehostunreach|eproto)\b|fetch failed|socket hang up|getaddrinfo/i;

export const statusOf = (err: unknown): number | null => {
  const carrier = err as StatusCarrier;
  for (const key of ['statusCode', 'status'] as const) {
    const raw = (carrier as Record<string, unknown>)?.[key];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
  }
  const text = err instanceof Error ? err.message : String(err ?? '');
  // Standard fetch failures name only the high-level status class phrase
  // ("Unauthorized") — map those too; low-confidence phrases leave null.
  const match = STATUS_TEXT.exec(text);
  if (match) {
    const code = Number(match[1]);
    if (code >= 400 && code <= 599) return code;
  }
  return null;
};

/*
 * Categorisation is fail-closed: ambiguous or bare status codes without
 * recognisable text fall to the status-class fallback (or 'unknown'), never
 * to a confident wrong story — e.g. a 403 with key-expiry text classifies as
 * invalid_or_expired_key, but a bare 403 stays 'forbidden'.
 */
export const categorize = (err: unknown, status: number | null): ModelErrorCategory => {
  const text = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  const keyPhrasing = /\b(api|auth)\s*key\b|credentials?|unauthor|expired/i.test(text);
  if (status === 401 || status === 403) {
    if (/expired/i.test(text) && keyPhrasing) return 'invalid_or_expired_key';
    if (/\bmissing\b|not configured|not set|not provided|no api key/i.test(text) && keyPhrasing)
      return 'missing_key';
    // Invalid/wrong-key text on 401/403: "invalid api key", "invalid
    // credentials", "unauthorized", "invalid bearer token".
    if (keyPhrasing) return 'invalid_or_expired_key';
    return status === 401 ? 'invalid_or_expired_key' : 'forbidden';
  }
  if (status === 404) return 'not_found';
  // #213: endpoint overload can arrive as 429 (`engine_overloaded` / "Model
  // busy, retry later"). Distinguish it from an account rate limit so the
  // tally matches the failover classifier in modelFailover.ts.
  if (status === 429 && isOverloadError(err)) return 'overloaded';
  if (status === 429) return 'rate_limit';
  if (status === 413 || /context length|maximum context|too long/i.test(text))
    return 'context_length';
  if (status === 503) return 'overloaded';
  if (status !== null && status >= 500) return 'server_error';
  if (status === 400) return 'bad_request';
  if (status !== null && status >= 400) return 'unknown';
  // No HTTP status: classify from transport-level text, else unknown.
  if (/unknown llm provider/i.test(text)) return 'unknown_provider';
  if (ABORT_TEXT.test(text)) return 'timeout';
  if (NETWORK_TEXT.test(text)) return 'network';
  return 'unknown';
};

// Fire-and-forget: never let diagnostics traffic fail the request. The
// filter mirrors the unique index; a $inc-after-upsert needs no version key.
export const recordModelError = (provider: string, model: string, err: unknown): void => {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const status = statusOf(err);
    const category = categorize(err, status);
    const message = redactForLog(err).slice(0, 500);
    ModelRouteError.collection
      .updateOne(
        { provider, model, status, category },
        {
          $inc: { count: 1 },
          $set: { lastSeenAt: new Date(), lastMessage: message },
        },
        { upsert: true },
      )
      .catch(() => {});
  } catch {
    // swallow: a tally failure must never break the in-flight request
  }
};
