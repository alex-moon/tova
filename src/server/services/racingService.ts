import { inferenceService } from './inferenceService';
import type {
  CompletionOptions,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
  NeutralStreamChunk,
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
 * #232: hedged provider racing.
 *
 * For the primary roster model (weighted pick in `rosterConfig`), every turn
 * fires the request to BOTH of its providers concurrently and keeps whichever
 * stream yields its first token first, aborting the loser immediately. On
 * total failure of the primary across both providers, the next model in the
 * roster is tried (up to a bounded number of attempts), reusing the #213 error
 * classification for transient vs hard errors.
 *
 * The winner's TTFT is recorded against (model, provider) so the next turn's
 * weighted pick reflects it.
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
 * Hard cap on roster attempts (mirrors MAX_ATTEMPTS in `modelFailover`): the
 * roster is 3 models / up to 6 provider calls, so this is generous but bounded.
 */
export const MAX_RACE_ATTEMPTS = 6;

/*
 * Feature gate for the #232 racing path. The roster runtime coexists with the
 * tier router (#233 deletes the latter); this flag lets the swap be staged.
 * Default ON everywhere except the test environment, where the chat-route
 * suites still stub the tier primitives. `ROSTER_RACING_ENABLED=0` forces it
 * off, `=1` forces it on.
 */
export const rosterRacingEnabled = (): boolean => {
  const raw = process.env.ROSTER_RACING_ENABLED;
  if (raw === '0') return false;
  if (raw === '1') return true;
  return process.env.NODE_ENV !== 'test';
};

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

type Chunk = NeutralStreamChunk;
type StreamIterator = AsyncIterator<Chunk>;

type FirstResult =
  | {
      kind: 'won';
      provider: RosterProviderRef;
      iterator: StreamIterator;
      first: Chunk;
      ttftMs: number;
    }
  | { kind: 'failed'; provider: RosterProviderRef; error: unknown };

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
 * Race one model's providers. Starts every provider's stream concurrently,
 * resolves with the first to yield a chunk (returning a resumed stream), and
 * aborts the rest. If every provider fails (or yields an empty stream),
 * rejects with the last non-abort error.
 *
 * The caller's `abortSignal` (client disconnect) is preserved on every call;
 * racing adds a per-provider controller so the loser is aborted independently.
 */
const raceProviders = async (
  model: RosterModel,
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  deps: RaceDeps,
): Promise<{ provider: RosterProviderRef; stream: NeutralChunkStream; ttftMs: number }> => {
  const start =
    deps.startStream ?? ((o: CompletionOptions) => inferenceService.createStreamingCompletion(o));
  const clock = nowFromDeps(deps);
  const controller = new AbortController();
  const started = clock();
  /*
   * The caller's abort signal (client disconnect) must still cancel every
   * provider call; the race controller cancels the losers. Each call gets a
   * combined signal so either source aborts it.
   */
  const clientSignal = options.abortSignal;

  const attempts = model.providers.map(async (providerRef): Promise<FirstResult> => {
    const perCall = new AbortController();
    const abortChild = () => perCall.abort();
    controller.signal.addEventListener('abort', abortChild, { once: true });
    try {
      const signal = clientSignal ? combineSignals(clientSignal, perCall.signal) : perCall.signal;
      const stream = await start({
        ...options,
        provider: providerRef.provider as LlmProvider,
        model: providerRef.modelId,
        abortSignal: signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = await iterator.next();
      if (next.done) throw new Error('Empty stream from provider');
      return {
        kind: 'won',
        provider: providerRef,
        iterator,
        first: next.value,
        ttftMs: Math.max(0, clock() - started),
      };
    } catch (error) {
      return { kind: 'failed', provider: providerRef, error };
    } finally {
      controller.signal.removeEventListener('abort', abortChild);
    }
  });

  const winner = await firstWin(attempts);
  if (winner) {
    // Abort every loser (per-provider controllers).
    controller.abort();
    return {
      provider: winner.provider,
      stream: resumeStream(winner.first, winner.iterator),
      ttftMs: winner.ttftMs,
    };
  }

  // No provider won: every attempt settled as `failed`. Surface a non-abort
  // error if any, else the first (an all-abort result means the client hung
  // up and the caller's abort classification handles it).
  const settled = await Promise.all(attempts);
  const errors = settled
    .filter((r): r is Extract<FirstResult, { kind: 'failed' }> => r.kind === 'failed')
    .map((r) => r.error);
  const failed = errors.find((e) => !isClientAbort(e)) ?? errors[0];
  throw failed ?? new Error('All providers failed');
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
 * Run one turn through the roster: pick the weighted primary, race its
 * providers, and on total failure cool off that model's providers and fall
 * through to the next roster model. Returns the winning stream and the model /
 * provider metadata.
 */
export const raceRoster = async (
  options: Omit<CompletionOptions, 'provider' | 'model'>,
  hasImage: boolean,
  deps: RaceDeps = {},
): Promise<RaceOutcome> => {
  const roster = await readRoster(deps);
  const candidates = rosterModelsForTurn(roster, hasImage);

  let lastError: unknown;
  let attempts = 0;
  // Track models already tried so fallback walks the roster without repeating.
  const tried = new Set<string>();

  while (attempts < MAX_RACE_ATTEMPTS) {
    const remaining = candidates.filter((m) => !tried.has(m.modelId));
    const primary = pickPrimary(remaining);
    if (!primary) break;
    attempts += 1;
    tried.add(primary.modelId);
    try {
      const raced = await raceProviders(primary, options, deps);
      const ttftMs = raced.ttftMs;
      // Fire-and-forget: a metrics write must never fail the turn.
      void recordTtft(primary.modelId, raced.provider.provider, ttftMs);
      return {
        result: { model: primary, provider: raced.provider, stream: raced.stream, ttftMs },
        attempts,
      };
    } catch (err) {
      lastError = err;
      if (isClientAbort(err)) throw err;
      if (isPromptSizeError(err)) throw err;
      if (isRateLimitError(err) && !isOverloadError(err)) throw err;
      // Transient/hard failure of the whole model: cool off each provider for
      // the appropriate TTL and fall through to the next model.
      const ttl = isOverloadError(err) ? overloadCoolOffMinutes() * 60 * 1000 : undefined;
      const disable = deps.disable ?? disableRosterProvider;
      await Promise.all(primary.providers.map((p) => disable(primary.modelId, p.provider, ttl)));
    }
  }
  throw lastError ?? new Error('No roster models available');
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
  hasImage: boolean,
  deps: RaceDeps = {},
): Promise<CompletionOutcome> => {
  const roster = await readRoster(deps);
  const candidates = rosterModelsForTurn(roster, hasImage);

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
          const completion = await start({
            ...options,
            provider: p.provider as LlmProvider,
            model: p.modelId,
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
export const pickRosterRoute = async (
  hasImage: boolean,
  deps: RaceDeps = {},
): Promise<RosterRoutingResult | null> => {
  const roster = await readRoster(deps);
  const primary = pickPrimary(rosterModelsForTurn(roster, hasImage));
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
  hasImage: boolean,
  deps: RaceDeps = {},
): Promise<{ routing: RosterRoutingResult; outcome: RaceOutcome }> => {
  const outcome = await raceRoster(options, hasImage, deps);
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
  hasImage: boolean,
  deps: RaceDeps = {},
): Promise<{ routing: RosterRoutingResult; outcome: CompletionOutcome }> => {
  const outcome = await raceRosterCompletion(options, hasImage, deps);
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
