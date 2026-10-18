import { redactForLog } from './logRedaction';
import { ModelRouteError } from '../models/ModelRouteError';
import { isOverloadError } from './providerErrors';

/* Per-route error tally: status, count and a coarse category per failure. */
// @see #175

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

// AI-SDK APICallError shape, plus plain Axios-style messages.
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
  // Standard fetch failures name only the status-class phrase; map those.
  const match = STATUS_TEXT.exec(text);
  if (match) {
    const code = Number(match[1]);
    if (code >= 400 && code <= 599) return code;
  }
  return null;
};

/* Categorisation is fail-closed: ambiguity falls to the fallback category. */
export const categorize = (err: unknown, status: number | null): ModelErrorCategory => {
  const text = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  const keyPhrasing = /\b(api|auth)\s*key\b|credentials?|unauthor|expired/i.test(text);
  if (status === 401 || status === 403) {
    if (/expired/i.test(text) && keyPhrasing) return 'invalid_or_expired_key';
    if (/\bmissing\b|not configured|not set|not provided|no api key/i.test(text) && keyPhrasing)
      return 'missing_key';
    // Invalid/wrong-key text on 401/403.
    if (keyPhrasing) return 'invalid_or_expired_key';
    return status === 401 ? 'invalid_or_expired_key' : 'forbidden';
  }
  if (status === 404) return 'not_found';
  // Overload can arrive as 429; distinguish it from an account rate limit.
  // @see #213
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

// Fire-and-forget: diagnostics traffic must never fail the request.
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
