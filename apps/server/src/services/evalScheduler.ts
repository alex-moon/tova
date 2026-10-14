/*
 * #225 scheduled eval runs. Modelled on `assetJobService`'s in-process
 * poller (no cron dependency is present, and one daily job does not justify
 * adding one). A tick is a no-op unless the current UTC day still has no run
 * and the configured start hour has passed, so restarts do not double-run;
 * a catch-up check closes the "redeploy around midnight" gap (OQ1 fallback).
 * The suites are injectable so tests drive them with fake timers.
 *
 * #289 T8: one tick now runs **both** eval suites — the tool-use golden suite
 * and the memory stage-2 (retrieval) suite — each with its **own** per-kind
 * idempotency, so a tool-use run today does not suppress the memory run (and
 * vice versa). They run **strictly sequentially** (D19): the two suites share
 * one reserved `evalUserId`, so they must never overlap. The lease
 * (`findRunning`, in the run services) stays **global** (D14) as the backstop
 * for a manual "Run now" overlapping a tick.
 *
 * Eval failures never crash the server: every suite is wrapped, each run
 * records its own `error` row, and a stale `running` lease older than the
 * sweep window is reclaimed at start (OQ7 fallback, mirroring
 * `requeueStaleAssetJobs`).
 */
import { EvalRunRecord } from '../models/EvalRunRecord';

const DEFAULT_TICK_MS = 15 * 60 * 1000;

// A stranded `running` row (server died mid-run) blocks all future runs
// under the serialisation lease, so the scheduler reclaims one older than
// this at start. 2× a generous suite duration.
export const STALE_EVAL_RUNNING_MS = 2 * 60 * 60 * 1000;

/** The two suites that share the `evalruns` collection (D9). */
export type EvalRunKind = 'tool-use' | 'memory';

/**
 * One suite a tick can run: a **per-kind** idempotency check plus the run
 * itself. The scheduler executes suites in array order and awaits each to
 * completion before the next, so the shared `evalUserId` fixtures cannot
 * clobber each other (D19).
 */
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
  /**
   * Boot self-heal for a stranded `running` lease. Injectable so timer tests
   * can disarm the Mongo call (fake timers otherwise stall the driver). Called
   * with no kind, so it reclaims a stranded row of **either** kind — correct,
   * because the lease is global (D14).
   */
  reclaimStaleRuns?: (maxAgeMs?: number, kind?: EvalRunKind) => Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

/** UTC midnight for the day containing `date`. */
export const utcDayStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * True when a run already exists for the current UTC day. Used by each suite's
 * per-kind gate (and the boot catch-up check). `kind` scopes the check so the
 * daily suite can run both kinds in one window (D14); omit it for the legacy
 * any-kind check.
 */
export const hasRunForUtcDay = async (
  now: Date = new Date(),
  kind?: EvalRunKind,
): Promise<boolean> => {
  const start = utcDayStart(now);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const existing = await EvalRunRecord.findOne({
    ...(kind ? { kind } : {}),
    startedAt: { $gte: start, $lt: end },
    // Any status counts: a failed run still occupied the window; re-running
    // is the manual "Run now" path, not the scheduler's job.
    status: { $in: ['running', 'done', 'error'] },
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return existing !== null;
};

/**
 * Reclaims a stranded `running` lease older than `maxAgeMs`. Mirrors
 * `requeueStaleAssetJobs`: the lease is settled to `error` (the run never
 * finished) so the next tick can proceed. `kind` scopes the sweep; the
 * scheduler omits it because the lease is global (D14).
 */
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

/**
 * One scheduler tick: catch-up-aware, idempotent per kind, never stacking.
 * Suites run strictly sequentially (D19); one suite's failure is caught so it
 * cannot skip the next (each run already records its own `error` row).
 */
export const runEvalSchedulerTick = async (
  suites: EvalSuite[],
  opts: EvalSchedulerOptions,
  now: Date = new Date(),
): Promise<void> => {
  if (!opts.enabled) return;
  if (!dueNow(opts, now)) return;
  for (const suite of suites) {
    if (await suite.hasRun(now)) continue;
    try {
      await suite.run();
    } catch {
      // A failed suite must not block the next one; the run service settles
      // the lease to `error` itself, so there is nothing to rethrow here.
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
