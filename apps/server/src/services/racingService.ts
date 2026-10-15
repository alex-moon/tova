import { inferenceService } from './inferenceService';
import type {
  CompletionOptions,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
  NeutralStreamChunk,
  TraceContext,
} from './llmTypes';
import { isClientAbort, isPromptSizeError, isRateLimitError } from './modelFailover';
import { isOverloadError } from './providerErrors';
import {
  disableRosterProvider,
  liveProviders,
  pickPrimary,
  recordTtft,
  RosterModel,
  RosterProvider,
  RosterProviderRef,
  rosterModelsForTurn,
} from './rosterConfig';
import { overloadCoolOffMinutes } from './modelConfigService';

/*
 * #232: hedged provider racing. #316: flat four-way race.
 *
 * Every turn fires the request at EVERY live (model, provider) combo of the
 * roster concurrently and keeps whichever stream yields its first token
 * first; the losers abort themselves. No model is pre-picked — the race
 * measures current latency per combo, which is the dominant variable (provider
 * load), rather than guessing from stale history. The weighted primary
 * (`pickPrimary`) survives for the non-streaming path and the pre-race `meta`
 * prediction only.
 *
 * Every combo that reaches a first chunk records its TTFT (input tokens are
 * fully billed regardless of abort timing, so observing a loser costs at most
 * one discarded chunk), so the rolling means per (model, provider) are no
 * longer winner-biased.
 */

/** A stream plus the fact that its first chunk has already been read. */
export interface RacedStream {
  model: RosterModel;
  provider: RosterProviderRef;
  /** Provider-neutral stream, including the winning first chunk. */
  stream: NeutralChunkStream;
  /** Time to first chunk, in ms (recorded against the provider). */
  ttftMs: number;
}

export interface RaceOutcome {
  result: RacedStream;
  /** Model/attempt metadata for tracing; the winner is `result`. */
  attempts: number;
}

/*
 * Routing metadata shaped like the tier router's `RoutingResult`, so the chat
 * routes can persist `model`/`provider` and size the output budget
 * (`contextLength`) without knowing which path produced it.
 */
export interface RosterRoutingResult {
  model: string;
  provider: LlmProvider;
  reason: string;
  contextLength?: number;
  /*
   * #214: kept structurally compatible with the tier `RoutingResult` so the
   * chat route can read `filesLikely` off either path. Racing does not call
   * the guard classifier (plan decision 7), so it is never set on a roster
   * pick — the library index is simply not injected on raced turns.
   */
  filesLikely?: boolean;
}

/*
 * Hard cap on completion-path attempts (mirrors MAX_ATTEMPTS in
 * `modelFailover`): only the non-streaming path still walks models one at a
 * time. Generous but bounded.
 */
export const MAX_RACE_ATTEMPTS = 6;

export interface RaceDeps {
  /** Override the roster read (tests). */
  roster?: RosterModel[];
  /** Override the streams (tests). */
  startStream?: (options: CompletionOptions) => Promise<NeutralChunkStream>;
  /** Override non-streaming completions (tests). */
  startCompletion?: (options: CompletionOptions) => Promise<NeutralCompletion>;
  /** Clock injected so TTFT is deterministic in tests. */
  now?: () => number;
  /** Cool-off writer (tests). */
  disable?: (modelId: string, provider: RosterProvider, ttlMs?: number) => Promise<boolean>;
}

const nowFromDeps = (deps: RaceDeps): (() => number) => deps.now ?? (() => Date.now());

/*
 * Resolve the roster: an injected roster for tests, else the live read. Kept
 * behind a helper so the dynamic import (which avoids a load-time cycle with
 * `rosterConfig`) is written once.
 */
const readRoster = async (deps: RaceDeps): Promise<RosterModel[]> =>
  deps.roster ?? (await import('./rosterConfig')).listRoster();

/*
 * Combine two abort signals into one that aborts when either does. Node 20.3+
 * ships `AbortSignal.any`; the manual fallback keeps older runtimes working.
 */
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

/*
 * #237: tag a raced provider call's trace so racing is debuggable in the
 * LangSmith UI (`race: 'roster'`, `provider:<name>`). Identifiers only — same
 * redaction rule as the rest of the trace context. The caller's own
 * tags/metadata are preserved.
 *
 * The winner is not tagged here: the span is created when the call starts, so
 * neither racer knows its fate yet. The loser is identifiable by its
 * abort/cancel error (filtered from the stats rollup), which is honest — the
 * span *was* cancelled, we just cannot know it would be the loser up front.
 */
const raceTrace = (base: TraceContext | undefined, provider: LlmProvider): TraceContext => ({
  ...(base?.sessionId ? { sessionId: base.sessionId } : {}),
  tags: [...(base?.tags ?? []), 'race:roster', `provider:${provider}`],
  metadata: { ...(base?.metadata ?? {}), race: 'roster', provider },
});

type Chunk = NeutralStreamChunk;
type StreamIterator = AsyncIterator<Chunk>;

type FirstResult =
  | {
      kind: 'won';
      model: RosterModel;
      provider: RosterProviderRef;
      iterator: StreamIterator;
      first: Chunk;
      ttftMs: number;
    }
  | { kind: 'failed'; model: RosterModel; provider: RosterProviderRef; error: unknown };

/*
 * Wrap an already-advanced iterator (its first chunk consumed) into a stream
 * that yields the buffered first chunk, then continues from the SAME iterator.
 * Re-iterating the original stream object would restart an async generator, so
 * the iterator is carried explicitly rather than replaced.
 */
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

/*
 * Race every (model, provider) combo. Starts every combo's stream
 * concurrently, resolves with the first to yield a chunk (returning a resumed
 * stream); losers abort THEMSELVES once their own first chunk arrives — after
 * recording its TTFT — so a loser mid-prefill is observed, not killed
 * (#316). Any model whose EVERY combo failed with a provider fault is cooled
 * off in the background (a hung provider must not be re-fired next turn); a
 * winner being present does not excuse a dead model.
 *
 * The caller's `abortSignal` (client disconnect) is preserved on every call;
 * each combo gets its own controller so losers abort independently.
 */
const raceCombos = async (
  combos: { model: RosterModel; ref: RosterProviderRef }[],
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps,
): Promise<RacedStream> => {
  const start =
    deps.startStream ?? ((o: CompletionOptions) => inferenceService.createStreamingCompletion(o));
  const clock = nowFromDeps(deps);
  const started = clock();
  const clientSignal = options.abortSignal;
  // Sync check-and-set: the first combo to yield a chunk claims the win; any
  // combo arriving after aborts itself (its TTFT is recorded either way).
  let winnerClaimed = false;
  const controllers = combos.map(() => new AbortController());

  const attempts = combos.map(async ({ model, ref }, i): Promise<FirstResult> => {
    const perCall = controllers[i];
    try {
      const signal = clientSignal ? combineSignals(clientSignal, perCall.signal) : perCall.signal;
      const provider = ref.provider as LlmProvider;
      const stream = await start({
        ...options,
        provider,
        model: ref.modelId,
        abortSignal: signal,
        trace: raceTrace(options.trace, provider),
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = await iterator.next();
      if (next.done) throw new Error('Empty stream from provider');
      const ttftMs = Math.max(0, clock() - started);
      // Fire-and-forget: a metrics write must never fail the turn.
      void recordTtft(model.modelId, ref.provider, ttftMs);
      if (winnerClaimed) perCall.abort();
      else winnerClaimed = true;
      return { kind: 'won', model, provider: ref, iterator, first: next.value, ttftMs };
    } catch (error) {
      return { kind: 'failed', model, provider: ref, error };
    }
  });

  /*
   * Cool off every combo of a model whose attempts ALL failed with a provider
   * fault (mirrors today's model-level bench on total failure). Client
   * aborts, prompt-size errors and rate limits are not the provider's fault —
   * they never cooled a model off.
   */
  const coolOffDeadModels = async (settled: FirstResult[]): Promise<void> => {
    const disable = deps.disable ?? disableRosterProvider;
    await Promise.all(
      candidatesToCool(combos, settled).map(({ model, ref }) => {
        const error = settled.find(
          (r) => r.kind === 'failed' && r.model.modelId === model.modelId && r.provider === ref,
        );
        const failedError = error && error.kind === 'failed' ? error.error : undefined;
        const ttl = isOverloadError(failedError) ? overloadCoolOffMinutes() * 60 * 1000 : undefined;
        return disable(model.modelId, ref.provider, ttl);
      }),
    );
  };

  const winner = await firstWin(attempts);
  if (winner) {
    // Bookkeeping without blocking the turn: dead-model cool-offs once every
    // attempt settles (losers may still be running to their first chunk).
    void Promise.all(attempts)
      .then(coolOffDeadModels)
      .catch(() => {});
    // Abort losers still in flight when the winner's stream completes — a
    // hung provider must not outlive the turn.
    const loserControllers = controllers.filter((_, i) => combos[i].ref !== winner.provider);
    const winnerStream = resumeStream(winner.first, winner.iterator);
    return {
      model: winner.model,
      provider: winner.provider,
      ttftMs: winner.ttftMs,
      stream: (async function* (): AsyncGenerator<Chunk, void, unknown> {
        try {
          for await (const chunk of winnerStream) yield chunk;
        } finally {
          for (const controller of loserControllers) controller.abort();
        }
      })(),
    };
  }

  // No combo won: every attempt settled as `failed`. Cool off the dead
  // models, then surface the most actionable error: a non-abort error if any
  // (prompt-size and rate limits included — today's code threw those before
  // any fallback), else the first abort (an all-abort result means the client
  // hung up).
  const settled = await Promise.all(attempts);
  await coolOffDeadModels(settled);
  const errors = settled
    .filter((r): r is Extract<FirstResult, { kind: 'failed' }> => r.kind === 'failed')
    .map((r) => r.error);
  const failed = errors.find((e) => !isClientAbort(e)) ?? errors[0];
  throw failed ?? new Error('All providers failed');
};

/*
 * The combos to cool off: every combo of a model whose attempts all failed,
 * where every failure is a provider fault (not a client abort, prompt-size
 * error or rate limit).
 */
const candidatesToCool = (
  combos: { model: RosterModel; ref: RosterProviderRef }[],
  settled: FirstResult[],
): { model: RosterModel; ref: RosterProviderRef }[] => {
  const isProviderFault = (error: unknown): boolean =>
    !isClientAbort(error) &&
    !isPromptSizeError(error) &&
    !(isRateLimitError(error) && !isOverloadError(error));
  const byModel = new Map<string, { model: RosterModel; combos: typeof combos }>();
  for (const combo of combos) {
    const entry = byModel.get(combo.model.modelId) ?? { model: combo.model, combos: [] };
    entry.combos.push(combo);
    byModel.set(combo.model.modelId, entry);
  }
  const dead: { model: RosterModel; ref: RosterProviderRef }[] = [];
  for (const { model, combos: modelCombos } of byModel.values()) {
    const results = modelCombos.map((c) =>
      settled.find((r) => r.model.modelId === model.modelId && r.provider === c.ref),
    );
    const allSettled = results.every((r) => r !== undefined);
    const allFailed = results.every((r) => r?.kind === 'failed');
    const allProviderFault = results.every(
      (r) => r !== undefined && r.kind === 'failed' && isProviderFault(r.error),
    );
    if (allSettled && allFailed && allProviderFault) dead.push(...modelCombos);
  }
  return dead;
};

/*
 * Resolve with the first provider that WINS, or null when ALL attempts fail.
 * Each attempt's result is routed through `settle`: a win resolves the
 * deferred immediately, a failure is recorded. When the last attempt settles
 * without a win, the deferred resolves null. This never hangs and never
 * resolves a failure as a win.
 */
const firstWin = (
  attempts: Promise<FirstResult>[],
): Promise<Extract<FirstResult, { kind: 'won' }> | null> => {
  return new Promise((resolve, reject) => {
    let remaining = attempts.length;
    let won = false;
    if (remaining === 0) {
      reject(new Error('No providers to race'));
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

/*
 * Run one streaming turn through the roster: fire every live (model, provider)
 * combo of every eligible model concurrently and keep the first token's
 * stream. There is no fallback loop — every combo is already in flight; if
 * all of them fail, `raceCombos` has cooled off the provider-fault combos and
 * the error surfaces directly.
 */
export const raceRoster = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps = {},
): Promise<RaceOutcome> => {
  const roster = await readRoster(deps);
  const candidates = rosterModelsForTurn(roster);
  const combos = candidates.flatMap((model) => model.providers.map((ref) => ({ model, ref })));
  if (combos.length === 0) throw new Error('No roster models available');
  const raced = await raceCombos(combos, options, deps);
  return { result: raced, attempts: 1 };
};

/*
 * Non-streaming variant: race the providers' non-streaming completions. The
 * first to RESOLVE wins (there is no first-token signal without a stream), the
 * losers are aborted, and the winner's TTFT-equivalent (time to completion) is
 * NOT recorded — TTFT is a streaming-only signal. We still record the
 * completion latency as a latency observation so the weighted pick has a
 * signal on non-streaming turns.
 *
 * Note: `createCompletion` on the neutral connector does not accept an abort
 * signal that cancels the HTTP call today (Mastra generate), so racing here
 * resolves with the first result and lets the others settle; only the winner's
 * value is used.
 */
export interface CompletionOutcome {
  result: {
    model: RosterModel;
    provider: RosterProviderRef;
    completion: NeutralCompletion;
  };
  attempts: number;
}

export const raceRosterCompletion = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps = {},
): Promise<CompletionOutcome> => {
  const roster = await readRoster(deps);
  const candidates = rosterModelsForTurn(roster);

  const start =
    deps.startCompletion ?? ((o: CompletionOptions) => inferenceService.createCompletion(o));

  let lastError: unknown;
  const tried = new Set<string>();
  for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS; attempt += 1) {
    const remaining = candidates.filter((m) => !tried.has(m.modelId));
    const primary = pickPrimary(remaining);
    if (!primary) break;
    tried.add(primary.modelId);
    const clock = nowFromDeps(deps);
    const started = clock();
    /*
     * Without a stream there is no first-token signal, so the race resolves
     * with the first provider whose completion RESOLVES. Unlike
     * `Promise.allSettled` (which waits for every provider before choosing),
     * this returns as soon as one provider is done and lets the slower ones
     * settle in the background — the whole point of racing is not to wait for
     * the loser. `createCompletion` cannot cancel the in-flight HTTP call
     * today, so the loser is not aborted, only ignored.
     */
    const attempts = primary.providers.map(
      async (p): Promise<CompletionOutcome['result'] | { failed: unknown }> => {
        try {
          const provider = p.provider as LlmProvider;
          const completion = await start({
            ...options,
            provider,
            model: p.modelId,
            trace: raceTrace(options.trace, provider),
          });
          return { model: primary, provider: p, completion };
        } catch (error) {
          return { failed: error };
        }
      },
    );
    const won = await firstCompletionWin(attempts);
    if (won) {
      const latency = Math.max(0, clock() - started);
      void recordTtft(primary.modelId, won.provider.provider, latency);
      return { result: won, attempts: attempt + 1 };
    }
    const settled = await Promise.all(attempts);
    const reason = settled.find((r): r is { failed: unknown } => 'failed' in r)?.failed;
    lastError = reason;
    if (isClientAbort(reason)) throw reason;
    if (isPromptSizeError(reason)) throw reason;
    if (isRateLimitError(reason) && !isOverloadError(reason)) throw reason;
    const ttl = isOverloadError(reason) ? overloadCoolOffMinutes() * 60 * 1000 : undefined;
    const disable = deps.disable ?? disableRosterProvider;
    await Promise.all(primary.providers.map((p) => disable(primary.modelId, p.provider, ttl)));
  }
  throw lastError ?? new Error('No roster models available');
};

/*
 * Resolve with the first provider completion to SUCCEED, or null when every
 * provider failed. Mirrors `firstWin` for the streaming path: a success
 * resolves immediately (the losers keep settling, unawaited), and only when the
 * last attempt fails without a success does the deferred resolve null.
 */
const firstCompletionWin = (
  attempts: Promise<CompletionOutcome['result'] | { failed: unknown }>[],
): Promise<CompletionOutcome['result'] | null> => {
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
          if ('failed' in r) {
            remaining -= 1;
            if (remaining === 0 && !won) resolve(null);
            return;
          }
          if (!won) {
            won = true;
            resolve(r);
          }
        },
        () => {
          remaining -= 1;
          if (remaining === 0 && !won) resolve(null);
        },
      );
    }
  });
};

/*
 * Metadata-only weighted primary pick for the chat routes: returns the model
 * the turn WILL be raced on, so the route can assemble the system prompt (and
 * send its `meta` event) before the stream starts. The actual racing happens
 * in `raceRoster` once the messages exist. `provider` here is the primary
 * provider's name for the pre-race `meta`; the winner is persisted from the
 * race outcome.
 */
export const pickRosterRoute = async (deps: RaceDeps = {}): Promise<RosterRoutingResult | null> => {
  const roster = await readRoster(deps);
  const primary = pickPrimary(rosterModelsForTurn(roster));
  if (!primary) return null;
  const providerRef = primary.providers[0];
  return {
    model: primary.modelId,
    provider: providerRef.provider as LlmProvider,
    reason: 'roster-pick',
    ...(primary.contextLength !== undefined ? { contextLength: primary.contextLength } : {}),
  };
};

/*
 * Streaming entry point for the chat routes: race the roster, then return both
 * the winning stream and a `RosterRoutingResult` the route can persist and
 * send in its `meta` event. The `reason` names the racing path (`roster-race`)
 * for tracing; the winning provider is where the tokens actually came from.
 */
export const routeAndStream = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps = {},
): Promise<{ routing: RosterRoutingResult; outcome: RaceOutcome }> => {
  const outcome = await raceRoster(options, deps);
  const { model, provider, ttftMs } = outcome.result;
  return {
    routing: {
      model: model.modelId,
      provider: provider.provider,
      reason: `roster-race;ttft:${Math.round(ttftMs)}`,
      ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    },
    outcome,
  };
};

/*
 * Non-streaming entry point for the chat routes: race the roster's completions,
 * then return both the winning completion and a `RosterRoutingResult` the route
 * can persist. `reason` names the racing path (`roster-race`) for tracing; the
 * winning provider is where the tokens actually came from. Parallel to
 * `routeAndStream` so the streaming and non-streaming routes shape persistence
 * identically.
 */
export const routeAndComplete = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps = {},
): Promise<{ routing: RosterRoutingResult; outcome: CompletionOutcome }> => {
  const outcome = await raceRosterCompletion(options, deps);
  const { model, provider } = outcome.result;
  return {
    routing: {
      model: model.modelId,
      provider: provider.provider,
      reason: 'roster-race',
      ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    },
    outcome,
  };
};

// Re-export for tests / callers.
export { liveProviders };
