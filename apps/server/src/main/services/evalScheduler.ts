/* Scheduled eval runs: in-process poller, at most one run per UTC day. */
// @see #225 #289
import { EvalRunRecord } from '../models/EvalRunRecord';

const DEFAULT_TICK_MS = 15 * 60 * 1000;

// A stranded `running` row blocks all future runs; reclaimed at start.
export const STALE_EVAL_RUNNING_MS = 2 * 60 * 60 * 1000;

/** The two suites that share the `evalruns` collection (D9). */
export type EvalRunKind = 'tool-use' | 'memory';

/* Suites execute in array order so shared fixtures cannot clobber. */
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
  /** Boot self-heal for a stranded `running` lease (global). */
  reclaimStaleRuns?: (maxAgeMs?: number, kind?: EvalRunKind) => Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

/** UTC midnight for the day containing `date`. */
export const utcDayStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** True when a run already exists for the current UTC day, any status. */
export const hasRunForUtcDay = async (
  now: Date = new Date(),
  kind?: EvalRunKind,
): Promise<boolean> => {
  const start = utcDayStart(now);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const existing = await EvalRunRecord.findOne({
    ...(kind ? { kind } : {}),
    startedAt: { $gte: start, $lt: end },
    // Any status counts; re-running is the manual "Run now" path.
    status: { $in: ['running', 'done', 'error'] },
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return existing !== null;
};

/* A failed autoIndex build never retries; the self-heal path rebuilds the
 * lease index so the atomic guarantee cannot silently vanish. @see #394 */
const ensureLeaseIndex = async (): Promise<void> => {
  try {
    await EvalRunRecord.collection.createIndex(
      { status: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'running' },
        name: 'evalruns_running_lease',
      },
    );
  } catch (error) {
    console.error('eval scheduler: lease index build failed:', error);
  }
};

/** Reclaims a stranded `running` lease older than `maxAgeMs`. */
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
  await ensureLeaseIndex();
  return result.modifiedCount ?? 0;
};

const dueNow = (opts: EvalSchedulerOptions, now: Date): boolean => {
  const hour = Number.isInteger(opts.hourUtc) ? Math.min(23, Math.max(0, opts.hourUtc!)) : 0;
  return now.getUTCHours() >= hour;
};

/** One tick: reclaim, then catch-up-aware, idempotent per kind, never stacking. */
export const runEvalSchedulerTick = async (
  suites: EvalSuite[],
  opts: EvalSchedulerOptions,
  now: Date = new Date(),
): Promise<void> => {
  if (!opts.enabled) return;
  if (!dueNow(opts, now)) return;
  // A stranded `running` lease must be cleared here, not only at boot.
  // @see #394
  try {
    await (opts.reclaimStaleRuns ?? reclaimStaleEvalRuns)();
  } catch (error) {
    console.error('eval scheduler: stale-lease reclaim failed:', error);
  }
  for (const suite of suites) {
    // Per-suite isolation: one suite's Mongo error must not skip the next.
    try {
      if (await suite.hasRun(now)) continue;
      await suite.run();
    } catch (error) {
      console.error('eval scheduler: suite %s failed:', suite.kind, error);
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
  void (opts.reclaimStaleRuns ?? reclaimStaleEvalRuns)().catch((error) => {
    console.error('eval scheduler: boot reclaim failed:', error);
  });
  timer = setInterval(() => {
    // A long run must not stack ticks; skip while one is in flight.
    if (busy) return;
    busy = true;
    void runEvalSchedulerTick(suites, opts)
      .catch((error) => {
        console.error('eval scheduler: tick failed:', error);
      })
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
