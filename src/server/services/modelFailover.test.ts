import type { RoutingResult } from './routerService';
import {
  AllModelsDisabledError,
  ALL_MODELS_DISABLED_MESSAGE,
  isOverloadError,
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
    mockDisableModel.mockReset().mockResolvedValue(true);
  });

  it('returns routing + completion untouched when the first invoke succeeds', async () => {
    const outcome = await withModelFailover(
      async () => ROUTE_A,
      async (routing) => ({
        routing,
        done: true,
      }),
    );
    expect(outcome.routing.model).toBe('m-a');
    expect(outcome.completion.done).toBe(true);
    expect(mockDisableModel).not.toHaveBeenCalled();
  });

  it('disables a failing endpoint and re-routes to the next model', async () => {
    const routes = [ROUTE_A, ROUTE_B];
    const outcome = await withModelFailover(
      async () => routes.shift()!,
      async (routing) => {
        if (routing.model === 'm-a') throw new Error('upstream 500');
        return 'ok-b';
      },
    );
    expect(outcome.routing.model).toBe('m-b');
    expect(mockDisableModel).toHaveBeenCalledTimes(1);
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'm-a', undefined);
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

  it('obtains the user-visible message when a disabled pool leaves routing empty', async () => {
    mockDisableModel.mockResolvedValueOnce(true);
    let routed = { ...ROUTE_A };
    const routing = async () => {
      // second lookup fails: m-a was disabled, m-b is gone from both test
      // pools — the router's loud empty-pool error must surface as the
      // all-disabled message once this loop disabled something.
      const current = routed;
      routed = null as unknown as RoutingResult;
      if (current.model === 'm-a') return current;
      throw new Error('No eligible models configured for tier: small');
    };
    await expect(
      withModelFailover(routing, async () => {
        throw new Error('upstream 500');
      }),
    ).rejects.toThrow(ALL_MODELS_DISABLED_MESSAGE);
  });

  it('does not disable on a client abort (the endpoint never failed)', async () => {
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

  it('does not disable on a prompt-size error (413 is a prompt problem)', async () => {
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

  // #213: endpoint overload (`engine_overloaded`, HTTP 429) is a per-endpoint
  // transient — cool off briefly and re-route, unlike a genuine account 429.
  it('re-routes on an engine_overloaded 429 with the short overload cool-off', async () => {
    const routes = [ROUTE_A, ROUTE_B];
    const overload = Object.assign(new Error('Model busy, retry later'), {
      statusCode: 429,
      data: { error: { code: 'engine_overloaded' } },
    });
    const outcome = await withModelFailover(
      async () => routes.shift()!,
      async (routing) => {
        if (routing.model === 'm-a') throw overload;
        return 'ok-b';
      },
    );
    expect(outcome.routing.model).toBe('m-b');
    expect(mockDisableModel).toHaveBeenCalledTimes(1);
    // Overload passes a short TTL (default 5 min) rather than the 6h default.
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'm-a', 5 * 60 * 1000);
  });

  it('re-routes on an overload message even without the body code', async () => {
    const routes = [ROUTE_A, ROUTE_B];
    const outcome = await withModelFailover(
      async () => routes.shift()!,
      async (routing) => {
        if (routing.model === 'm-a') {
          throw new Error('Streaming error: Error: Model busy, retry later');
        }
        return 'ok-b';
      },
    );
    expect(outcome.routing.model).toBe('m-b');
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'm-a', 5 * 60 * 1000);
  });

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

  it('a genuine 429 rate limit still fails immediately without disabling', async () => {
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

  // #168: a failed cool-off write must stop the loop — the pool is
  // unchanged, so a re-route would re-pick the same broken endpoint.
  it('surfaces the original endpoint error without re-routing when the cool-off write fails', async () => {
    mockDisableModel.mockResolvedValueOnce(false);
    let routeCalls = 0;
    let invokes = 0;
    const err = new Error('upstream 500');
    await expect(
      withModelFailover(
        async () => {
          routeCalls += 1;
          return ROUTE_A;
        },
        async () => {
          invokes += 1;
          throw err;
        },
      ),
    ).rejects.toBe(err);
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'm-a', undefined);
    expect(routeCalls).toBe(1);
    expect(invokes).toBe(1);
  });
});
