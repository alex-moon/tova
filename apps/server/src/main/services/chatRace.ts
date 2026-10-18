import { inferenceService } from './inferenceService';
import { CHAT_MODEL, chatBackends, contextLengthFor } from './modelDefaults';
import type {
  CompletionOptions,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
  NeutralStreamChunk,
} from './llmTypes';

/* Hedged provider race for the fixed chat model; first token wins. */
// @see #387

export interface FixedRoutingResult {
  model: string;
  provider: LlmProvider;
  reason: string;
  contextLength?: number;
}

export interface ChatRaceDeps {
  /** Override the backends raced (tests). */
  backends?: { provider: LlmProvider; modelId: string }[];
  /** Override the streams (tests). */
  startStream?: (options: CompletionOptions) => Promise<NeutralChunkStream>;
  /** Override non-streaming completions (tests). */
  startCompletion?: (options: CompletionOptions) => Promise<NeutralCompletion>;
  /** Clock injected so TTFT is deterministic in tests. */
  now?: () => number;
}

/* Tag a raced call's trace (identifiers only, caller tags preserved). */
const raceTrace = (base: CompletionOptions['trace'], provider: LlmProvider) => ({
  ...(base?.sessionId ? { sessionId: base.sessionId } : {}),
  tags: [...(base?.tags ?? []), 'race:chat', `provider:${provider}`],
  metadata: { ...(base?.metadata ?? {}), race: 'chat', provider },
});

type Chunk = NeutralStreamChunk;
type StreamIterator = AsyncIterator<Chunk>;

type CompletionAttempt =
  | { provider: LlmProvider; completion: NeutralCompletion }
  | { provider: LlmProvider; failed: unknown };

type FirstResult =
  | {
      kind: 'won';
      provider: LlmProvider;
      modelId: string;
      iterator: StreamIterator;
      first: Chunk;
      ttftMs: number;
    }
  | { kind: 'failed'; provider: LlmProvider; error: unknown };

/* Combine two abort signals; fallback when AbortSignal.any is absent. */
const combineSignals = (a: AbortSignal, b: AbortSignal): AbortSignal => {
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  if (a.aborted || b.aborted) merged.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return merged.signal;
};

/* Stream an already-advanced iterator: buffered first chunk, then continue. */
const resumeStream = (first: Chunk, iterator: StreamIterator): NeutralChunkStream => {
  return (async function* (): AsyncGenerator<Chunk, void, unknown> {
    yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
};

/* First winner, or null when ALL attempts fail; never hangs. */
const firstWin = (
  attempts: Promise<FirstResult>[],
): Promise<Extract<FirstResult, { kind: 'won' }> | null> => {
  return new Promise((resolve) => {
    let remaining = attempts.length;
    let won = false;
    if (remaining === 0) {
      resolve(null);
      return;
    }
    for (const attempt of attempts) {
      attempt.then(
        (r) => {
          if (r.kind === 'won') {
            if (!won) {
              won = true;
              resolve(r);
            }
            return;
          }
          remaining -= 1;
          if (remaining === 0 && !won) resolve(null);
        },
        () => {
          // `attempt` itself never rejects (it catches), but guard anyway.
          remaining -= 1;
          if (remaining === 0 && !won) resolve(null);
        },
      );
    }
  });
};

const routingFor = (provider: LlmProvider, reason: string): FixedRoutingResult => ({
  model: CHAT_MODEL,
  provider,
  reason,
  ...(contextLengthFor(CHAT_MODEL) !== undefined
    ? { contextLength: contextLengthFor(CHAT_MODEL) }
    : {}),
});

/* Race every backend; losers abort after the winner's first chunk. */
const raceStream = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: ChatRaceDeps,
): Promise<{ routing: FixedRoutingResult; stream: NeutralChunkStream }> => {
  const backends = deps.backends ?? chatBackends();
  if (backends.length === 0) throw new Error('No chat backends configured');
  const start =
    deps.startStream ?? ((o: CompletionOptions) => inferenceService.createStreamingCompletion(o));
  const clock = deps.now ?? (() => Date.now());
  const started = clock();
  const clientSignal = options.abortSignal;
  // First backend to yield a chunk claims the win; late ones abort.
  let winnerClaimed = false;
  const controllers = backends.map(() => new AbortController());

  const attempts = backends.map(async ({ provider, modelId }, i): Promise<FirstResult> => {
    const perCall = controllers[i];
    try {
      const signal = clientSignal ? combineSignals(clientSignal, perCall.signal) : perCall.signal;
      const stream = await start({
        ...options,
        provider,
        model: modelId,
        abortSignal: signal,
        trace: raceTrace(options.trace, provider),
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = await iterator.next();
      if (next.done) throw new Error('Empty stream from provider');
      const ttftMs = Math.max(0, clock() - started);
      if (winnerClaimed) perCall.abort();
      else winnerClaimed = true;
      return { kind: 'won', provider, modelId, iterator, first: next.value, ttftMs };
    } catch (error) {
      return { kind: 'failed', provider, error };
    }
  });

  const winner = await firstWin(attempts);
  if (!winner) {
    const settled = await Promise.all(attempts);
    const errors = settled
      .filter((r): r is Extract<FirstResult, { kind: 'failed' }> => r.kind === 'failed')
      .map((r) => r.error);
    throw errors[0] ?? new Error('All chat backends failed');
  }
  // Abort losers when the winner's stream completes; don't outlive the turn.
  const loserControllers = controllers.filter((_, i) => backends[i].provider !== winner.provider);
  const winnerStream = resumeStream(winner.first, winner.iterator);
  return {
    routing: routingFor(winner.provider, `fixed-model;ttft:${Math.round(winner.ttftMs)}`),
    stream: (async function* (): AsyncGenerator<Chunk, void, unknown> {
      try {
        for await (const chunk of winnerStream) yield chunk;
      } finally {
        for (const controller of loserControllers) controller.abort();
      }
    })(),
  };
};

/* First completion to RESOLVE wins, or null when all fail; never hangs. */
const firstCompletionWin = (
  attempts: Promise<CompletionAttempt>[],
): Promise<Extract<CompletionAttempt, { completion: NeutralCompletion }> | null> => {
  return new Promise((resolve) => {
    let remaining = attempts.length;
    let won = false;
    if (remaining === 0) {
      resolve(null);
      return;
    }
    for (const attempt of attempts) {
      attempt.then(
        (r) => {
          if (!('failed' in r)) {
            if (!won) {
              won = true;
              resolve(r);
            }
            return;
          }
          remaining -= 1;
          if (remaining === 0 && !won) resolve(null);
        },
        () => {
          remaining -= 1;
          if (remaining === 0 && !won) resolve(null);
        },
      );
    }
  });
};

/* Non-streaming race: first completion to RESOLVE wins. */
const raceCompletion = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: ChatRaceDeps,
): Promise<{ routing: FixedRoutingResult; completion: NeutralCompletion }> => {
  const backends = deps.backends ?? chatBackends();
  if (backends.length === 0) throw new Error('No chat backends configured');
  const start =
    deps.startCompletion ?? ((o: CompletionOptions) => inferenceService.createCompletion(o));

  // First resolver wins; slower ones settle in the background, ignored.
  const attempts = backends.map(async ({ provider, modelId }): Promise<CompletionAttempt> => {
    try {
      const completion = await start({
        ...options,
        provider,
        model: modelId,
        trace: raceTrace(options.trace, provider),
      });
      return { provider, completion };
    } catch (error) {
      return { provider, failed: error as unknown };
    }
  });
  const won = await firstCompletionWin(attempts);
  if (won) {
    return { routing: routingFor(won.provider, 'fixed-model'), completion: won.completion };
  }
  const settled = await Promise.all(attempts);
  const failures = settled
    .filter((r): r is Extract<CompletionAttempt, { failed: unknown }> => 'failed' in r)
    .map((r) => r.failed);
  throw failures[0] ?? new Error('All chat backends failed');
};

/* Metadata-only route so callers can name the model before the race. */
export const chatRoute = (): FixedRoutingResult =>
  routingFor(chatBackends()[0]?.provider ?? 'deepinfra', 'fixed-model');

/* Streaming entry for the chat route. */
export const raceChatStream = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: ChatRaceDeps = {},
): Promise<{ routing: FixedRoutingResult; stream: NeutralChunkStream }> =>
  raceStream(options, deps);

/* Non-streaming entry, parallel to raceChatStream for identical shapes. */
export const raceChatCompletion = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: ChatRaceDeps = {},
): Promise<{ routing: FixedRoutingResult; completion: NeutralCompletion }> =>
  raceCompletion(options, deps);
