import {
  isClientAbort,
  isOverloadError,
  isPromptSizeError,
  isRateLimitError,
} from '../../main/services/modelFailover';

/* Error classification the racing runtime reuses to decide abort vs cool-off vs loud failure. */
// @see #233
describe('provider error classification (#168/#213)', () => {
  it('isClientAbort matches AbortError and CanceledError only', () => {
    expect(isClientAbort(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))).toBe(
      true,
    );
    expect(isClientAbort(Object.assign(new Error('canceled'), { name: 'CanceledError' }))).toBe(
      true,
    );
    expect(isClientAbort(new Error('upstream 500'))).toBe(false);
    expect(isClientAbort(undefined)).toBe(false);
  });

  it('isPromptSizeError matches status 413 and the "Request too large" body', () => {
    expect(isPromptSizeError(Object.assign(new Error('nope'), { statusCode: 413 }))).toBe(true);
    expect(isPromptSizeError(new Error('Request too large'))).toBe(true);
    expect(isPromptSizeError(Object.assign(new Error('quota'), { statusCode: 429 }))).toBe(false);
  });

  // The rate-limit matcher must stay as broad as the 429 discrimination in streamingErrorMessage — a TPM/RPM body rethrown without a status code must not disable.
  // @see #168
  it('a rate-limit message without a status code is matched in all message shapes', () => {
    for (const message of [
      'Rate limit exceeded',
      'rate_limit_exceeded',
      'Tokens per minute (TPM) limit reached',
      'Requests per minute (RPM) quota exhausted',
      'Too Many Requests',
    ]) {
      expect(isRateLimitError(new Error(message))).toBe(true);
    }
    expect(isRateLimitError(Object.assign(new Error('over quota'), { statusCode: 429 }))).toBe(
      true,
    );
    expect(isRateLimitError(new Error('upstream 500'))).toBe(false);
    expect(isRateLimitError(Object.assign(new Error('bad gateway'), { statusCode: 502 }))).toBe(
      false,
    );
  });

  // Endpoint overload (`engine_overloaded`, HTTP 429) is a per-endpoint transient, distinct from a genuine account rate limit.
  // @see #213
  it('isOverloadError distinguishes overload from a genuine rate limit', () => {
    expect(
      isOverloadError(
        Object.assign(new Error('busy'), {
          statusCode: 429,
          data: { error: { code: 'engine_overloaded' } },
        }),
      ),
    ).toBe(true);
    expect(isOverloadError(new Error('Model busy, retry later'))).toBe(true);
    expect(
      isOverloadError(Object.assign(new Error('rate_limit_exceeded'), { statusCode: 429 })),
    ).toBe(false);
    expect(isOverloadError(new Error('Rate limit reached for model m-a'))).toBe(false);
    expect(isOverloadError(new Error('upstream 500'))).toBe(false);
  });
});
