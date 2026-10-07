/*
 * #225 scheduled eval runs. Modelled on `assetJobService`'s in-process
 * poller (no cron dependency is present, and one daily job does not justify
 * adding one). A tick is a no-op unless the current UTC day still has no run
 * and the configured start hour has passed, so restarts do not double-run;
 * a catch-up check closes the "redeploy around midnight" gap (OQ1 fallback).
 * The run function is injectable so tests drive it with fake timers.
 *
 * Eval failures never crash the server: every tick is wrapped, the run
 * function records its own `error` row, and a stale `running` lease older
 * than the sweep window is reclaimed at start (OQ7 fallback, mirroring
 * `requeueStaleAssetJobs`).
 */
import { EvalRunRecord } from '../models/EvalRunRecord';

const DEFAULT_TICK_MS = 15 * 60 * 1000;

// A stranded `running` row (server died mid-run) blocks all future runs
// under the serialisation lease, so the scheduler reclaims one older than
// this at start. 2× a generous suite duration.
export const STALE_EVAL_RUNNING_MS = 2 * 60 * 60 * 1000;

export interface EvalSchedulerOptions {
  enabled: boolean;
  /** Earliest UTC hour (0–23) a daily run may start. Default 0 (midnight). */
  hourUtc?: number;
  tickMs?: number;
  /**
   * Boot self-heal for a stranded `running` lease. Injectable so timer tests
   * can disarm the Mongo call (fake timers otherwise stall the driver).
   */
  reclaimStaleRuns?: () => Promise<unknown>;
  /**
   * Per-window idempotency check, defaulting to `hasRunForUtcDay`. Injectable
   * for the same reason: timer tests need a Mongo-free tick.
   */
  hasRun?: (now: Date) => Promise<boolean>;
}

/** Runs one suite; supplied by the caller (defaults to startEvalRun). */
export type EvalSchedulerRun = () => Promise<unknown>;

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

/** UTC midnight for the day containing `date`. */
export const utcDayStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * True when a run already exists for the current UTC day. Used both by the
 * tick (idempotency) and the boot catch-up check.
 */
export const hasRunForUtcDay = async (now: Date = new Date()): Promise<boolean> => {
  const start = utcDayStart(now);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const existing = await EvalRunRecord.findOne({
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
 * finished) so the next tick can proceed.
 */
export const reclaimStaleEvalRuns = async (
  maxAgeMs: number = STALE_EVAL_RUNNING_MS,
): Promise<number> => {
  const result = await EvalRunRecord.updateMany(
    { status: 'running', startedAt: { $lt: new Date(Date.now() - maxAgeMs) } },
    { $set: { status: 'error', finishedAt: new Date(), error: 'stale lease reclaimed' } },
  );
  return result.modifiedCount ?? 0;
};

const dueNow = (opts: EvalSchedulerOptions, now: Date): boolean => {
  const hour = Number.isInteger(opts.hourUtc) ? Math.min(23, Math.max(0, opts.hourUtc!)) : 0;
  return now.getUTCHours() >= hour;
};

/** One scheduler tick: catch-up-aware, idempotent per UTC day, never stacking. */
export const runEvalSchedulerTick = async (
  run: EvalSchedulerRun,
  opts: EvalSchedulerOptions,
  now: Date = new Date(),
): Promise<void> => {
  if (!opts.enabled) return;
  if (!dueNow(opts, now)) return;
  if (await (opts.hasRun ?? hasRunForUtcDay)(now)) return;
  await run();
};

export const startEvalScheduler = (
  run: EvalSchedulerRun,
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
    void runEvalSchedulerTick(run, opts)
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
