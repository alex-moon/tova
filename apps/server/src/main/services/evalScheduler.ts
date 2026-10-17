/* Scheduled eval runs: an in-process poller (modelled on assetJobService); a tick is a no-op unless the UTC day has no run per kind; both suites run strictly sequentially; failures never crash the server. */
// @see #225 #289
import { EvalRunRecord } from '../models/EvalRunRecord';

const DEFAULT_TICK_MS = 15 * 60 * 1000;

// A stranded `running` row blocks all future runs, so the scheduler reclaims one older than this (2× a generous suite duration) at start.
export const STALE_EVAL_RUNNING_MS = 2 * 60 * 60 * 1000;

/** The two suites that share the `evalruns` collection (D9). */
export type EvalRunKind = 'tool-use' | 'memory';

/* One suite a tick can run: a per-kind idempotency check plus the run; suites execute in array order so the shared fixtures cannot clobber each other. */
export interface EvalSuite {
  kind: EvalRunKind;
  /** True when this kind already ran in the current UTC day. */
  hasRun: (now: Date) => Promise<boolean>;
  /** Runs the suite to completion; the run records its own terminal row. */
  run: () => Promise<unknown>;
}

export interface EvalSchedulerOptions {
  enabled: boolean;
  /** Earliest UTC hour (0–23) a daily run may start. Default 0 (midnight). */
  hourUtc?: number;
  tickMs?: number;
  /** Boot self-heal for a stranded `running` lease; called with no kind because the lease is global. Injectable so timer tests can disarm the Mongo call. */
  reclaimStaleRuns?: (maxAgeMs?: number, kind?: EvalRunKind) => Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

/** UTC midnight for the day containing `date`. */
export const utcDayStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** True when a run already exists for the current UTC day, scoped by kind when given; any status counts (a failed run still occupied the window). */
export const hasRunForUtcDay = async (
  now: Date = new Date(),
  kind?: EvalRunKind,
): Promise<boolean> => {
  const start = utcDayStart(now);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const existing = await EvalRunRecord.findOne({
    ...(kind ? { kind } : {}),
    startedAt: { $gte: start, $lt: end },
    // Any status counts: a failed run still occupied the window; re-running is the manual "Run now" path.
    status: { $in: ['running', 'done', 'error'] },
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return existing !== null;
};

/** Reclaims a stranded `running` lease older than `maxAgeMs`, settling it to `error`; scopes by kind when given. */
export const reclaimStaleEvalRuns = async (
  maxAgeMs: number = STALE_EVAL_RUNNING_MS,
  kind?: EvalRunKind,
): Promise<number> => {
  const result = await EvalRunRecord.updateMany(
    {
      ...(kind ? { kind } : {}),
      status: 'running',
      startedAt: { $lt: new Date(Date.now() - maxAgeMs) },
    },
    { $set: { status: 'error', finishedAt: new Date(), error: 'stale lease reclaimed' } },
  );
  return result.modifiedCount ?? 0;
};

const dueNow = (opts: EvalSchedulerOptions, now: Date): boolean => {
  const hour = Number.isInteger(opts.hourUtc) ? Math.min(23, Math.max(0, opts.hourUtc!)) : 0;
  return now.getUTCHours() >= hour;
};

/** One scheduler tick: catch-up-aware, idempotent per kind, never stacking; one suite's failure is caught so it cannot skip the next. */
export const runEvalSchedulerTick = async (
  suites: EvalSuite[],
  opts: EvalSchedulerOptions,
  now: Date = new Date(),
): Promise<void> => {
  if (!opts.enabled) return;
  if (!dueNow(opts, now)) return;
  for (const suite of suites) {
    // Both the idempotency check and the run are isolated per suite: a transient Mongo error in one suite's `hasRun` must not skip the next.
    try {
      if (await suite.hasRun(now)) continue;
      await suite.run();
    } catch {
      // A failed suite must not block the next one.
    }
  }
};

export const startEvalScheduler = (
  suites: EvalSuite[],
  opts: EvalSchedulerOptions,
): ReturnType<typeof setInterval> | null => {
  if (!opts.enabled) return null;
  if (timer) return timer;
  // Self-heal a stranded lease before the first tick (OQ7).
  void (opts.reclaimStaleRuns ?? reclaimStaleEvalRuns)().catch(() => undefined);
  timer = setInterval(() => {
    // A long run must not stack ticks; skip while one is in flight.
    if (busy) return;
    busy = true;
    void runEvalSchedulerTick(suites, opts)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, opts.tickMs ?? DEFAULT_TICK_MS);
  timer.unref?.();
  return timer;
};

export const stopEvalScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

export const isEvalSchedulerRunning = (): boolean => timer !== null;
