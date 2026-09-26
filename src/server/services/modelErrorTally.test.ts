import { categorize, recordModelError, statusOf } from './modelErrorTally';

const errWith = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra);

describe('modelErrorTally', () => {
  describe('statusOf', () => {
    it('reads AI-SDK statusCode and status properties', () => {
      expect(statusOf(errWith('x', { statusCode: 401 }))).toBe(401);
      expect(statusOf(errWith('x', { status: 403 }))).toBe(403);
    });

    it('falls back to the "status code" phrasing in the message', () => {
      expect(statusOf(errWith('Request failed with status code 403'))).toBe(403);
    });

    it('returns null for non-HTTP and non-numeric failures', () => {
      expect(statusOf(new Error('Unknown LLM provider: bigquery'))).toBeNull();
      expect(statusOf(errWith('x', { statusCode: '401' }))).toBeNull();
    });
  });

  describe('categorize', () => {
    it('distinguishes missing-key from invalid/expired-key phrasing', () => {
      expect(
        categorize(errWith('Authentication Fingerprint was provided but api key is missing'), 401),
      ).toBe('missing_key');
      expect(categorize(errWith('api key is expired'), 401)).toBe('invalid_or_expired_key');
      expect(categorize(errWith('Invalid API key'), 401)).toBe('invalid_or_expired_key');
    });

    it('keeps confident categories for status-only failures', () => {
      expect(categorize(errWith('too many requests'), 429)).toBe('rate_limit');
      expect(categorize(errWith('service unavailable'), 503)).toBe('overloaded');
      expect(categorize(errWith('internal server error'), 500)).toBe('server_error');
      expect(categorize(errWith('prompt is too long'), 400)).toBe('context_length');
      expect(categorize(errWith('not found'), 404)).toBe('not_found');
    });

    it('fails closed on ambiguous texts', () => {
      expect(categorize(errWith('denied routing permission'), 403)).toBe('forbidden');
      expect(categorize(new Error('Unknown LLM provider: xyz'), null)).toBe('unknown_provider');
      expect(categorize(new Error('ETIMEDOUT'), null)).toBe('network');
      expect(categorize(new Error('request aborted'), null)).toBe('timeout');
      expect(categorize(new Error('silent failure'), null)).toBe('unknown');
    });
  });

  describe('recordModelError', () => {
    it('is a no-op in test env and never throws synchronously', () => {
      expect(() =>
        recordModelError(
          'deepinfra',
          'Qwen/Qwen3-14B',
          errWith('Invalid API key', { statusCode: 401 }),
        ),
      ).not.toThrow();
    });
  });
});
