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

/* Hedged racing: fire every combo, keep the first stream to yield a token. */
// @see #232 #316

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

/* Routing metadata shaped like the tier router's RoutingResult. */
export interface RosterRoutingResult {
  model: string;
  provider: LlmProvider;
  reason: string;
  contextLength?: number;
  // Compatible with the tier RoutingResult; chat routes read either path.
  // @see #214
  filesLikely?: boolean;
}

/* Hard cap on attempts (mirrors modelFailover's MAX_ATTEMPTS). */
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

/* Roster read (injected or live); the dynamic import is written once. */
const readRoster = async (deps: RaceDeps): Promise<RosterModel[]> =>
  deps.roster ?? (await import('./rosterConfig')).listRoster();

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

/* Tag a raced call's trace (identifiers only, caller tags preserved). */
// @see #237
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

/* Race every combo; losers abort after TTFT; dead models cool off. */
// @see #316
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
  // First combo to yield a chunk claims the win; late ones abort.
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

  /* Cool off models whose attempts ALL failed with a provider fault. */
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
    // Dead-model cool-offs run once every attempt settles, non-blocking.
    void Promise.all(attempts)
      .then(coolOffDeadModels)
      .catch(() => {});
    // Abort losers when the winner's stream completes; don't outlive turn.
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

  // No combo won: cool off dead models, surface the most actionable error.
  const settled = await Promise.all(attempts);
  await coolOffDeadModels(settled);
  const errors = settled
    .filter((r): r is Extract<FirstResult, { kind: 'failed' }> => r.kind === 'failed')
    .map((r) => r.error);
  const failed = errors.find((e) => !isClientAbort(e)) ?? errors[0];
  throw failed ?? new Error('All providers failed');
};

/* Dead-model detection: all combos failed with provider faults. */
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

/* First winner, or null when ALL attempts fail; never hangs. */
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

/* One streaming turn through the roster; first token wins. */
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

/* Non-streaming race: first completion to RESOLVE wins; latency recorded. */
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
    // First resolver wins; slower ones settle in the background, ignored.
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

/* First provider completion to SUCCEED, else null (mirrors firstWin). */
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

/* Metadata-only pick so routes can send meta before the stream starts. */
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

/* Streaming entry for chat routes: race the roster, return the winner. */
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

/* Non-streaming entry, parallel to routeAndStream for identical shapes. */
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
