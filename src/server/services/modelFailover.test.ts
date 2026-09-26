import type { RoutingResult } from './routerService';
import {
  AllModelsDisabledError,
  ALL_MODELS_DISABLED_MESSAGE,
  isRateLimitError,
  withModelFailover,
} from './modelFailover';

const ROUTE_A: RoutingResult = { model: 'm-a', provider: 'deepinfra', reason: 'test' };
const ROUTE_B: RoutingResult = { model: 'm-b', provider: 'deepinfra', reason: 'test' };

const mockDisableModel = jest.fn();

jest.mock('./modelConfigService', () => ({
  // Keep the real module (AllModelsDisabledError is re-exported through it);
  // stub only disableModel so the cool-off path never touches the DB.
  ...jest.requireActual('./modelConfigService'),
  disableModel: (...args: unknown[]) => mockDisableModel(...args),
}));

describe('withModelFailover (#168)', () => {
  beforeEach(() => {
    mockDisableModel.mockReset().mockResolvedValue(undefined);
  });

  it('returns routing + completion untouched when the first invoke succeeds', async () => {
    const outcome = await withModelFailover(
      async () => ROUTE_A,
      async () => 'ok',
    );
    expect(outcome).toEqual({ routing: ROUTE_A, completion: 'ok' });
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  it('disables a failed endpoint and retries the route with the fresh pool', async () => {
    const routes = [ROUTE_A, ROUTE_B];
    const outcome = await withModelFailover(
      async () => routes.shift()!,
      async (routing) => {
        if (routing.model === 'm-a') throw new Error('upstream 500');
        return 'ok-b';
      },
    );
    expect(outcome).toEqual({ routing: ROUTE_B, completion: 'ok-b' });
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'm-a');
    expect(mockDisableModel).toHaveBeenCalledTimes(1);
  });

  it('obtains the user-visible message when a disabled pool leaves routing empty', async () => {
    mockDisableModel.mockResolvedValueOnce(undefined);
    let routed = { ...ROUTE_A };
    const routing = async () => {
      // second lookup fails: m-a was disabled, m-b is gone from both test
      // pools — the pool drained
      if (routed.model === 'm-a') {
        routed = { ...ROUTE_B };
        return routed;
      }
      throw new Error('No eligible models configured for tier: large');
    };
    await withModelFailover(routing, async (r) => {
      if (r.model === 'm-a') throw new Error('upstream 500');
      throw new Error('m-b is also failing');
    }).catch((err) => {
      expect(err).toBeInstanceOf(AllModelsDisabledError);
      expect(err.message).toContain(ALL_MODELS_DISABLED_MESSAGE);
    });
  });

  it('rethrows the original route error when no model was disabled yet', async () => {
    await expect(
      withModelFailover(
        async () => {
          throw new Error('No eligible models configured for tier: large');
        },
        async () => 'never',
      ),
    ).rejects.toThrow('No eligible models configured for tier: large');
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  it('a client abort fails immediately and does not disable the endpoint', async () => {
    const abort = new Error('Request aborted');
    abort.name = 'AbortError';
    await expect(
      withModelFailover(
        async () => ROUTE_A,
        async () => {
          throw abort;
        },
      ),
    ).rejects.toThrow('Request aborted');
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  it('a prompt-size (413) failure fails immediately and does not disable the endpoint', async () => {
    await expect(
      withModelFailover(
        async () => ROUTE_A,
        async () => {
          throw Object.assign(new Error('Request too large'), { statusCode: 413 });
        },
      ),
    ).rejects.toThrow('Request too large');
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  // #168 (decision 2026-09-26): 429 is rate-limit back-off territory, a
  // separate mechanism from cool-off. Until back-off exists, a 429 fails the
  // turn loudly without disabling the endpoint and without retry-draining
  // the pool.
  it('a 429 status failure fails immediately and does not disable or retry', async () => {
    let invokes = 0;
    await expect(
      withModelFailover(
        async () => ROUTE_A,
        async () => {
          invokes += 1;
          throw Object.assign(new Error('quota exceeded'), { statusCode: 429 });
        },
      ),
    ).rejects.toThrow('quota exceeded');
    expect(mockDisableModel).not.toHaveBeenCalled();
    expect(invokes).toBe(1);
  });

  it('a rate-limit message failure fails immediately and does not disable', async () => {
    await expect(
      withModelFailover(
        async () => ROUTE_A,
        async () => {
          throw new Error('Rate limit reached for model m-a');
        },
      ),
    ).rejects.toThrow(/rate limit/i);
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  // #168: the rate-limit matcher must stay as broad as the 429
  // discrimination in `streamingErrorMessage` (routes/chat.ts) — a
  // Groq-style TPM/RPM body rethrown without a status code must not disable.
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

  it('an AllModelsDisabledError escaping route passes through untouched', async () => {
    const poolDrained = new AllModelsDisabledError();
    await expect(
      withModelFailover(
        async () => {
          throw poolDrained;
        },
        async () => 'never',
      ),
    ).rejects.toBe(poolDrained);
    expect(mockDisableModel).not.toHaveBeenCalled();
  });
});
