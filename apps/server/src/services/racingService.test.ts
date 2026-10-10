import { raceRoster, raceRosterCompletion, routeAndComplete, RaceDeps } from './racingService';
import { RosterModel } from './rosterConfig';
import type { CompletionOptions, NeutralCompletion, NeutralStreamChunk } from './llmTypes';

/*
 * #232 racing runtime: hedge both providers, first token wins, loser aborted.
 *
 * Every dependency is injected (roster, stream factory, clock, cool-off
 * writer), so no Mongo or real provider is touched and TTFT is deterministic.
 * `recordTtft`/`disableRosterProvider` live in `rosterConfig`; the module is
 * mocked so their fire-and-forget writes can be asserted.
 */

const mockRecordTtft = jest.fn(async () => {});
jest.mock('./rosterConfig', () => {
  const actual = jest.requireActual('./rosterConfig');
  return {
    ...actual,
    recordTtft: (...args: unknown[]) => mockRecordTtft(...args),
    disableRosterProvider: jest.fn(async () => true),
  };
});

const model = (overrides: Partial<RosterModel> = {}): RosterModel => ({
  modelId: 'm-primary',
  label: 'Primary',
  tools: true,
  vision: true,
  inputPrice: 0.2,
  outputPrice: 0.6,
  providers: [
    { provider: 'deepinfra', modelId: 'di-primary' },
    { provider: 'fireworks', modelId: 'fw-primary' },
  ],
  ...overrides,
});

// A stream that yields each chunk, tracking abort calls. `signal` is the
// combined signal passed by the race; the generator notices aborts between
// yields so a loser stops cleanly.
const streamOf = (
  chunks: NeutralStreamChunk[],
  onAbort?: () => void,
  signal?: AbortSignal,
): AsyncGenerator<NeutralStreamChunk> => {
  return (async function* () {
    for (const chunk of chunks) {
      if (signal?.aborted) {
        onAbort?.();
        return;
      }
      // Yield control so the concurrent providers interleave deterministically.
      await Promise.resolve();
      yield chunk;
    }
  })();
};

describe('racingService (#232)', () => {
  beforeEach(() => {
    mockRecordTtft.mockClear();
  });

  it('picks the first provider to yield a token and aborts the loser', async () => {
    const aborted: string[] = [];
    // Mutable clock: advanced by the slow provider's first-token arrival so
    // the fast (fireworks) provider wins with the smaller TTFT.
    let clockMs = 0;
    const deps: RaceDeps = {
      roster: [model()],
      now: () => clockMs,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          // Slow: resolves after a macrotask during which the fast provider
          // has already produced our simulated clock advance.
          return (async function* () {
            await new Promise((r) => setTimeout(r, 5));
            clockMs = 40;
            yield { delta: 'slow' };
          })();
        }
        return (async function* () {
          clockMs = 10;
          yield { delta: 'fast' };
        })();
      },
    };

    const outcome = await raceRoster({ messages: [] }, false, deps);
    expect(outcome.result.provider.provider).toBe('fireworks');
    expect(outcome.result.provider.modelId).toBe('fw-primary');
    expect(outcome.result.ttftMs).toBe(10);

    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['fast']);
    expect(mockRecordTtft).toHaveBeenCalledWith('m-primary', 'fireworks', 10);
    // `aborted` is unused here (streams don't observe the signal in this
    // variant); the abort assertion lives in the dedicated test below.
    expect(aborted).toEqual([]);
  });

  it('aborts the losing provider via the race controller', async () => {
    let loserSignal: AbortSignal | undefined;
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          loserSignal = options.abortSignal;
          // Never yields: it can only end by abort.
          return (async function* () {
            await new Promise((r) => setTimeout(r, 1000));
            yield { delta: 'never' };
          })();
        }
        return streamOf([{ delta: 'winner' }]);
      },
    };
    await raceRoster({ messages: [] }, false, deps);
    // The race aborts losers synchronously once a winner resolves.
    expect(loserSignal?.aborted).toBe(true);
  });

  it('tags both provider calls with race + provider trace context (#237)', async () => {
    const seen: CompletionOptions[] = [];
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        seen.push(options);
        // Fireworks yields first; deepinfra never yields (aborted loser).
        return options.provider === 'fireworks'
          ? streamOf([{ delta: 'win' }])
          : (async function* () {
              await new Promise((r) => setTimeout(r, 1000));
              yield { delta: 'never' };
            })();
      },
    };

    await raceRoster(
      { messages: [], trace: { sessionId: 'sess-1', tags: ['chat'], metadata: { turn: 1 } } },
      false,
      deps,
    );

    expect(seen).toHaveLength(2);
    for (const options of seen) {
      // The caller's own trace context is preserved.
      expect(options.trace?.sessionId).toBe('sess-1');
      expect(options.trace?.tags).toEqual(
        expect.arrayContaining(['chat', 'race:roster', `provider:${options.provider}`]),
      );
      expect(options.trace?.metadata).toMatchObject({
        turn: 1,
        race: 'roster',
        provider: options.provider,
      });
    }
  });

  it('returns a resumed stream that includes the winning first chunk', async () => {
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 5,
      startStream: async () => streamOf([{ delta: 'A' }, { delta: 'B' }, { delta: 'C' }]),
    };
    const outcome = await raceRoster({ messages: [] }, false, deps);
    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['A', 'B', 'C']);
  });

  it('falls through to the next model when the primary model totally fails', async () => {
    const second: RosterModel = {
      modelId: 'm-second',
      label: 'Second',
      tools: true,
      vision: true,
      inputPrice: 1,
      outputPrice: 1,
      providers: [{ provider: 'deepinfra', modelId: 'di-second' }],
    };
    const disabled: Array<{ model: string; provider: string }> = [];
    const deps: RaceDeps = {
      roster: [model(), second],
      now: () => 1,
      disable: async (modelId, provider) => {
        disabled.push({ model: modelId, provider });
        return true;
      },
      startStream: async (options: CompletionOptions) => {
        if (options.model === 'di-second') return streamOf([{ delta: 'second' }]);
        throw new Error(`boom ${options.model}`);
      },
    };
    const outcome = await raceRoster({ messages: [] }, false, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    expect(disabled).toEqual(
      expect.arrayContaining([
        { model: 'm-primary', provider: 'deepinfra' },
        { model: 'm-primary', provider: 'fireworks' },
      ]),
    );
  });

  it('restricts image turns to vision-capable roster models', async () => {
    const textOnly: RosterModel = {
      modelId: 'text-only',
      label: 'Text',
      tools: true,
      vision: false,
      providers: [{ provider: 'deepinfra', modelId: 'di-text' }],
    };
    const visionModel = model({ modelId: 'vision', label: 'Vision' });
    const seen: string[] = [];
    const deps: RaceDeps = {
      roster: [textOnly, visionModel],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        seen.push(options.model);
        return streamOf([{ delta: 'ok' }]);
      },
    };
    await raceRoster({ messages: [] }, true, deps);
    expect(seen).not.toContain('di-text');
  });

  it('does not disable on a rate-limit (non-overload) error — fails loudly', async () => {
    const disable = jest.fn(async () => true);
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      disable,
      startStream: async () => {
        const err = new Error('Too many requests, rate limit');
        (err as { statusCode?: number }).statusCode = 429;
        throw err;
      },
    };
    await expect(raceRoster({ messages: [] }, false, deps)).rejects.toThrow(/rate limit/i);
    expect(disable).not.toHaveBeenCalled();
  });

  it('does not disable on a prompt-size error — fails loudly', async () => {
    const disable = jest.fn(async () => true);
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      disable,
      startStream: async () => {
        const err = new Error('Request too large');
        (err as { statusCode?: number }).statusCode = 413;
        throw err;
      },
    };
    await expect(raceRoster({ messages: [] }, false, deps)).rejects.toThrow(/too large/i);
    expect(disable).not.toHaveBeenCalled();
  });

  it('cools off an overloaded model with a short TTL and falls through', async () => {
    const second: RosterModel = {
      modelId: 'm-second',
      label: 'Second',
      tools: true,
      vision: true,
      providers: [{ provider: 'deepinfra', modelId: 'di-second' }],
    };
    const ttlSeen: Array<number | undefined> = [];
    const deps: RaceDeps = {
      roster: [model(), second],
      now: () => 1,
      disable: async (_m, _p, ttl) => {
        ttlSeen.push(ttl);
        return true;
      },
      startStream: async (options: CompletionOptions) => {
        if (options.model === 'di-second') return streamOf([{ delta: 'ok' }]);
        throw new Error('engine_overloaded: Model busy, retry later');
      },
    };
    const outcome = await raceRoster({ messages: [] }, false, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    expect(ttlSeen.every((t) => typeof t === 'number' && t > 0)).toBe(true);
  });

  it('uses the weighted score to pick the primary (cheaper wins at equal TTFT)', async () => {
    const cheap = model({
      modelId: 'cheap',
      inputPrice: 0.1,
      outputPrice: 0.1,
      providers: [{ provider: 'deepinfra', modelId: 'di-cheap' }],
    });
    const pricey = model({
      modelId: 'pricey',
      inputPrice: 1,
      outputPrice: 1,
      providers: [{ provider: 'deepinfra', modelId: 'di-pricey' }],
    });
    let firstModel = '';
    const deps: RaceDeps = {
      roster: [pricey, cheap],
      now: () => 1,
      disable: async () => true,
      startStream: async (options: CompletionOptions) => {
        firstModel = options.model;
        return streamOf([{ delta: 'ok' }]);
      },
    };
    await raceRoster({ messages: [] }, false, deps);
    expect(firstModel).toBe('di-cheap');
  });

  it('throws when the roster has no usable model', async () => {
    const deps: RaceDeps = {
      roster: [model({ providers: [] })],
      now: () => 1,
      disable: async () => true,
      startStream: async () => streamOf([{ delta: 'ok' }]),
    };
    await expect(raceRoster({ messages: [] }, false, deps)).rejects.toThrow();
  });
});

describe('racingService non-streaming (#232)', () => {
  beforeEach(() => {
    mockRecordTtft.mockClear();
  });

  const completionOf = (content: string): NeutralCompletion => ({
    choices: [{ message: { content } }],
  });

  it('races the providers and returns the first completion to resolve', async () => {
    const clock = { now: 0 };
    const deps: RaceDeps = {
      roster: [model()],
      now: () => clock.now,
      startCompletion: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          // Loses: resolves only after the faster provider has already won.
          await new Promise((r) => setTimeout(r, 10));
          clock.now = 50;
          return completionOf('slow');
        }
        clock.now = 7;
        return completionOf('fast');
      },
    };
    const outcome = await raceRosterCompletion({ messages: [] }, false, deps);
    expect(outcome.result.provider.provider).toBe('fireworks');
    expect(outcome.result.completion.choices[0]?.message?.content).toBe('fast');
    expect(mockRecordTtft).toHaveBeenCalledWith('m-primary', 'fireworks', 7);
  });

  it('routeAndComplete shapes routing from the winning model', async () => {
    const deps: RaceDeps = {
      roster: [
        model({
          modelId: 'winner',
          contextLength: 4096,
          providers: [{ provider: 'deepinfra', modelId: 'di-winner' }],
        }),
      ],
      now: () => 1,
      startCompletion: async () => completionOf('hi'),
    };
    const { routing, outcome } = await routeAndComplete({ messages: [] }, false, deps);
    expect(routing).toEqual({
      model: 'winner',
      provider: 'deepinfra',
      reason: 'roster-race',
      contextLength: 4096,
    });
    expect(outcome.result.completion.choices[0]?.message?.content).toBe('hi');
  });

  it('falls through to the next model when the primary totally fails', async () => {
    const second: RosterModel = {
      modelId: 'm-second',
      label: 'Second',
      tools: true,
      vision: true,
      // Priced higher than the primary so the weighted pick still tries
      // `m-primary` first and exercises the fall-through.
      inputPrice: 1,
      outputPrice: 1,
      providers: [{ provider: 'deepinfra', modelId: 'di-second' }],
    };
    const disabled: Array<{ model: string; provider: string }> = [];
    const deps: RaceDeps = {
      roster: [model(), second],
      now: () => 1,
      disable: async (modelId, provider) => {
        disabled.push({ model: modelId, provider });
        return true;
      },
      startCompletion: async (options: CompletionOptions) => {
        if (options.model === 'di-second') return completionOf('second');
        throw new Error(`boom ${options.model}`);
      },
    };
    const outcome = await raceRosterCompletion({ messages: [] }, false, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    expect(disabled).toEqual(
      expect.arrayContaining([
        { model: 'm-primary', provider: 'deepinfra' },
        { model: 'm-primary', provider: 'fireworks' },
      ]),
    );
  });

  it('excludes text-only models on image turns', async () => {
    const textOnly: RosterModel = {
      modelId: 'text',
      label: 'Text',
      tools: true,
      vision: false,
      providers: [{ provider: 'deepinfra', modelId: 'di-text' }],
    };
    const vision = model({ modelId: 'vision', label: 'Vision' });
    const seen: string[] = [];
    const deps: RaceDeps = {
      roster: [textOnly, vision],
      now: () => 1,
      startCompletion: async (options: CompletionOptions) => {
        seen.push(options.model);
        return completionOf('ok');
      },
    };
    await raceRosterCompletion({ messages: [] }, true, deps);
    expect(seen).not.toContain('di-text');
  });
});
