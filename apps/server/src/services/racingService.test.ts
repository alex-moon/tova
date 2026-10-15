import { raceRoster, raceRosterCompletion, routeAndComplete, RaceDeps } from './racingService';
import { RosterModel } from './rosterConfig';
import type { CompletionOptions, NeutralCompletion, NeutralStreamChunk } from './llmTypes';

/*
 * #316 racing runtime: flat race across every live (model, provider) combo,
 * first token wins, losers record their TTFT and abort themselves.
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('racingService (#316 flat race)', () => {
  beforeEach(() => {
    mockRecordTtft.mockClear();
  });

  it('starts every roster combo and keeps the first token', async () => {
    const seen: string[] = [];
    const deps: RaceDeps = {
      roster: [
        model(),
        model({
          modelId: 'm-second',
          label: 'Second',
          providers: [
            { provider: 'deepinfra', modelId: 'di-second' },
            { provider: 'fireworks', modelId: 'fw-second' },
          ],
        }),
      ],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        seen.push(options.model);
        return streamOf([{ delta: 'ok' }]);
      },
    };

    const outcome = await raceRoster({ messages: [] }, deps);
    // All four combos are in flight — no pre-pick decides the model.
    expect(seen).toEqual(
      expect.arrayContaining(['di-primary', 'fw-primary', 'di-second', 'fw-second']),
    );
    expect(outcome.result.model.modelId).toBe('m-primary');
    expect(outcome.result.provider.provider).toBe('deepinfra');
  });

  it('keeps the fastest combo even when it is not the first model', async () => {
    // Mutable clock: advanced by the slow providers' first-token arrival so
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

    const outcome = await raceRoster({ messages: [] }, deps);
    expect(outcome.result.provider.provider).toBe('fireworks');
    expect(outcome.result.provider.modelId).toBe('fw-primary');
    expect(outcome.result.ttftMs).toBe(10);

    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['fast']);
    expect(mockRecordTtft).toHaveBeenCalledWith('m-primary', 'fireworks', 10);
  });

  it('records the loser’s TTFT too — it self-aborts after its first chunk (#316)', async () => {
    let loserSignal: AbortSignal | undefined;
    let clockMs = 0;
    let releaseLoser!: () => void;
    const loserGate = new Promise<void>((r) => {
      releaseLoser = r;
    });
    const deps: RaceDeps = {
      roster: [model()],
      now: () => clockMs,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          // The winner: first chunk immediately.
          clockMs = 10;
          return streamOf([{ delta: 'win' }]);
        }
        loserSignal = options.abortSignal;
        // The loser: held mid-prefill until the test releases it, so its
        // first chunk arrives AFTER the winner claimed the race.
        return (async function* () {
          await loserGate;
          clockMs = 40;
          yield { delta: 'loser' };
        })();
      },
    };

    const outcome = await raceRoster({ messages: [] }, deps);
    releaseLoser();
    await flush();

    // The loser's observation landed (input was fully billed regardless) and
    // it aborted itself — nobody consumes its stream.
    expect(mockRecordTtft).toHaveBeenCalledWith('m-primary', 'fireworks', 40);
    expect(loserSignal?.aborted).toBe(true);

    // The winner's stream is unaffected.
    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['win']);
  });

  it('aborts losers still in flight when the winner’s stream completes', async () => {
    let loserSignal: AbortSignal | undefined;
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') return streamOf([{ delta: 'win' }]);
        loserSignal = options.abortSignal;
        // Never yields: it can only end by the end-of-turn cleanup.
        return (async function* () {
          await new Promise((r) => setTimeout(r, 1000));
          yield { delta: 'never' };
        })();
      },
    };

    const outcome = await raceRoster({ messages: [] }, deps);
    expect(loserSignal?.aborted).toBe(false); // alive while the turn runs — its TTFT is pending
    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    // Winner's stream done: the hung loser must not outlive the turn.
    expect(loserSignal?.aborted).toBe(true);
  });

  it('tags every combo’s provider call with race + provider trace context (#237)', async () => {
    const seen: CompletionOptions[] = [];
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      startStream: async (options: CompletionOptions) => {
        seen.push(options);
        return streamOf([{ delta: 'win' }]);
      },
    };

    await raceRoster(
      { messages: [], trace: { sessionId: 'sess-1', tags: ['chat'], metadata: { turn: 1 } } },
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
    const outcome = await raceRoster({ messages: [] }, deps);
    const tokens: string[] = [];
    for await (const chunk of outcome.result.stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['A', 'B', 'C']);
  });

  it('a totally failed model cools off while another model’s combo serves the turn', async () => {
    const second: RosterModel = {
      modelId: 'm-second',
      label: 'Second',
      tools: true,
      inputPrice: 1,
      outputPrice: 1,
      providers: [{ provider: 'deepinfra', modelId: 'di-second' }],
    };
    const disabled: Array<{ model: string; provider: string; ttl: number | undefined }> = [];
    const deps: RaceDeps = {
      roster: [model(), second],
      now: () => 1,
      disable: async (modelId, provider, ttl) => {
        disabled.push({ model: modelId, provider, ttl });
        return true;
      },
      startStream: async (options: CompletionOptions) => {
        if (options.model === 'di-second') return streamOf([{ delta: 'second' }]);
        throw new Error(`boom ${options.model}`);
      },
    };
    const outcome = await raceRoster({ messages: [] }, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    // Provider-fault failures cool off both combos of the dead model; the
    // winning model is untouched.
    expect(disabled).toEqual(
      expect.arrayContaining([
        { model: 'm-primary', provider: 'deepinfra', ttl: undefined },
        { model: 'm-primary', provider: 'fireworks', ttl: undefined },
      ]),
    );
    expect(disabled.some((d) => d.model === 'm-second')).toBe(false);
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
    await expect(raceRoster({ messages: [] }, deps)).rejects.toThrow(/rate limit/i);
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
    await expect(raceRoster({ messages: [] }, deps)).rejects.toThrow(/too large/i);
    expect(disable).not.toHaveBeenCalled();
  });

  it('cools off an overloaded combo with a short TTL while another combo serves', async () => {
    const second: RosterModel = {
      modelId: 'm-second',
      label: 'Second',
      tools: true,
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
    const outcome = await raceRoster({ messages: [] }, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    expect(ttlSeen.every((t) => typeof t === 'number' && t > 0)).toBe(true);
  });

  it('throws when the roster has no usable model', async () => {
    const deps: RaceDeps = {
      roster: [model({ providers: [] })],
      now: () => 1,
      disable: async () => true,
      startStream: async () => streamOf([{ delta: 'ok' }]),
    };
    await expect(raceRoster({ messages: [] }, deps)).rejects.toThrow();
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
    const outcome = await raceRosterCompletion({ messages: [] }, deps);
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
    const { routing, outcome } = await routeAndComplete({ messages: [] }, deps);
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
    const outcome = await raceRosterCompletion({ messages: [] }, deps);
    expect(outcome.result.model.modelId).toBe('m-second');
    expect(disabled).toEqual(
      expect.arrayContaining([
        { model: 'm-primary', provider: 'deepinfra' },
        { model: 'm-primary', provider: 'fireworks' },
      ]),
    );
  });
});
