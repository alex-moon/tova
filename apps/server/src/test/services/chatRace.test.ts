import {
  chatRoute,
  raceChatCompletion,
  raceChatStream,
  type ChatRaceDeps,
} from '../../main/services/chatRace';
import type { CompletionOptions, NeutralStreamChunk } from '../../main/services/llmTypes';

/* Hedged chat race: first token/resolution wins, losers stopped. @see #387 */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

const BACKENDS = [
  { provider: 'deepinfra' as const, modelId: 'di-chat' },
  { provider: 'fireworks' as const, modelId: 'fw-chat' },
];

// A stream yielding chunks; the generator notices aborts between yields.
const streamOf = (
  chunks: NeutralStreamChunk[],
  signal?: AbortSignal,
): AsyncGenerator<NeutralStreamChunk> =>
  (async function* () {
    for (const chunk of chunks) {
      if (signal?.aborted) return;
      await Promise.resolve();
      yield chunk;
    }
  })();

describe('chatRoute', () => {
  it('names the default chat model on its first backend', () => {
    const routing = chatRoute();
    expect(routing.model).toBe('zai-org/GLM-5.3-Flash');
    expect(routing.provider).toBe('deepinfra');
    expect(routing.reason).toBe('fixed-model');
    expect(routing.contextLength).toBe(1048576);
  });
});

describe('raceChatStream', () => {
  it('starts every backend and keeps the first token', async () => {
    const seen: string[] = [];
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        seen.push(options.model);
        return streamOf([{ delta: 'ok' }]);
      },
    };
    const { routing, stream } = await raceChatStream({ messages: [] }, deps);
    expect(seen).toEqual(expect.arrayContaining(['di-chat', 'fw-chat']));
    expect(routing.provider).toBe('deepinfra');
    expect(routing.reason).toMatch(/^fixed-model;ttft:\d+$/);
    const tokens: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['ok']);
  });

  it('keeps the fastest backend even when it is listed second', async () => {
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          return (async function* () {
            await new Promise((r) => setTimeout(r, 5));
            yield { delta: 'slow' };
          })();
        }
        return streamOf([{ delta: 'fast' }]);
      },
    };
    const { routing, stream } = await raceChatStream({ messages: [] }, deps);
    expect(routing.provider).toBe('fireworks');
    const tokens: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['fast']);
  });

  it('self-aborts a late loser after the winner claimed the race', async () => {
    let loserSignal: AbortSignal | undefined;
    let releaseLoser!: () => void;
    const loserGate = new Promise<void>((r) => {
      releaseLoser = r;
    });
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') return streamOf([{ delta: 'win' }]);
        loserSignal = options.abortSignal;
        return (async function* () {
          await loserGate;
          yield { delta: 'loser' };
        })();
      },
    };
    const { stream } = await raceChatStream({ messages: [] }, deps);
    releaseLoser();
    await flush();
    expect(loserSignal?.aborted).toBe(true);
    const tokens: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['win']);
  });

  it('aborts losers when the winner’s stream completes', async () => {
    let loserSignal: AbortSignal | undefined;
    let releaseLoser!: () => void;
    const loserGate = new Promise<void>((r) => {
      releaseLoser = r;
    });
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') return streamOf([{ delta: 'a' }, { delta: 'b' }]);
        loserSignal = options.abortSignal;
        return (async function* () {
          await loserGate;
          yield { delta: 'loser' };
        })();
      },
    };
    const { stream } = await raceChatStream({ messages: [] }, deps);
    const tokens: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['a', 'b']);
    releaseLoser();
    await flush();
    expect(loserSignal?.aborted).toBe(true);
  });

  it('falls through to the next backend when one yields an empty stream', async () => {
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') return streamOf([]);
        return streamOf([{ delta: 'fw' }]);
      },
    };
    const { routing, stream } = await raceChatStream({ messages: [] }, deps);
    expect(routing.provider).toBe('fireworks');
    const tokens: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta) tokens.push(chunk.delta);
    }
    expect(tokens).toEqual(['fw']);
  });

  it('surfaces an actionable provider error when a client abort also failed', async () => {
    const rateLimit = Object.assign(new Error('rate limit exceeded'), { statusCode: 429 });
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') throw abortError();
        throw rateLimit;
      },
    };
    await expect(raceChatStream({ messages: [] }, deps)).rejects.toBe(rateLimit);
  });

  it('throws when every backend fails', async () => {
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async () => {
        throw new Error('provider down');
      },
    };
    await expect(raceChatStream({ messages: [] }, deps)).rejects.toThrow('provider down');
  });

  it('propagates a client abort that precedes any chunk', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startStream: async (options: CompletionOptions) => {
        if (options.abortSignal?.aborted) throw abortError();
        return streamOf([{ delta: 'late' }]);
      },
    };
    await expect(
      raceChatStream({ messages: [], abortSignal: controller.signal }, deps),
    ).rejects.toThrow();
  });
});

describe('raceChatCompletion', () => {
  it('resolves with the first completion to settle', async () => {
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startCompletion: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          await new Promise((r) => setTimeout(r, 5));
          return { choices: [{ message: { content: 'slow' } }] };
        }
        return { choices: [{ message: { content: 'fast' } }] };
      },
    };
    const { routing, completion } = await raceChatCompletion({ messages: [] }, deps);
    expect(routing.provider).toBe('fireworks');
    expect(routing.model).toBe('zai-org/GLM-5.3-Flash');
    expect(completion.choices[0]?.message?.content).toBe('fast');
  });

  it('aborts the losing completion once a winner resolves', async () => {
    let winnerSignal: AbortSignal | undefined;
    let loserSignal: AbortSignal | undefined;
    let releaseLoser!: () => void;
    const loserGate = new Promise<void>((r) => {
      releaseLoser = r;
    });
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startCompletion: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') {
          winnerSignal = options.abortSignal;
          return { choices: [{ message: { content: 'win' } }] };
        }
        loserSignal = options.abortSignal;
        await loserGate;
        return { choices: [{ message: { content: 'lose' } }] };
      },
    };
    const { routing, completion } = await raceChatCompletion({ messages: [] }, deps);
    expect(routing.provider).toBe('deepinfra');
    expect(completion.choices[0]?.message?.content).toBe('win');
    // The loser was told to stop; the winner's call is untouched.
    expect(loserSignal?.aborted).toBe(true);
    expect(winnerSignal?.aborted).toBe(false);
    releaseLoser();
    await flush();
  });

  it('surfaces an actionable provider error when a client abort also failed', async () => {
    const rateLimit = Object.assign(new Error('rate limit exceeded'), { statusCode: 429 });
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startCompletion: async (options: CompletionOptions) => {
        if (options.provider === 'deepinfra') throw abortError();
        throw rateLimit;
      },
    };
    await expect(raceChatCompletion({ messages: [] }, deps)).rejects.toBe(rateLimit);
  });

  it('throws when every backend fails', async () => {
    const deps: ChatRaceDeps = {
      backends: BACKENDS,
      startCompletion: async () => {
        throw new Error('provider down');
      },
    };
    await expect(raceChatCompletion({ messages: [] }, deps)).rejects.toThrow('provider down');
  });
});
