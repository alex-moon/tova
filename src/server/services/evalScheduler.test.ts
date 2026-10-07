import { EvalRunRecord } from '../models/EvalRunRecord';
import {
  hasRunForUtcDay,
  isEvalSchedulerRunning,
  reclaimStaleEvalRuns,
  runEvalSchedulerTick,
  startEvalScheduler,
  stopEvalScheduler,
  STALE_EVAL_RUNNING_MS,
  utcDayStart,
} from './evalScheduler';

/*
 * #225 scheduler coverage. The run function is injected so no suite executes;
 * the shared jest setup provides the in-memory Mongo.
 */

const opts = { enabled: true, tickMs: 1000 };
const at = (iso: string) => new Date(iso);

describe('utcDayStart / hasRunForUtcDay (#225)', () => {
  it('starts at UTC midnight of the containing day', () => {
    expect(utcDayStart(at('2026-10-07T13:45:00Z')).toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('is true only when a run exists in the current UTC day', async () => {
    expect(await hasRunForUtcDay(at('2026-10-07T13:45:00Z'))).toBe(false);
    await EvalRunRecord.create({ startedAt: at('2026-10-07T00:05:00Z'), status: 'done' });
    expect(await hasRunForUtcDay(at('2026-10-07T13:45:00Z'))).toBe(true);
    // A run the previous day does not satisfy today.
    expect(await hasRunForUtcDay(at('2026-10-08T00:05:00Z'))).toBe(false);
  });
});

describe('runEvalSchedulerTick (#225)', () => {
  it('is a no-op when disabled', async () => {
    let runs = 0;
    await runEvalSchedulerTick(
      async () => {
        runs += 1;
      },
      { enabled: false },
      at('2026-10-07T00:30:00Z'),
    );
    expect(runs).toBe(0);
  });

  it('does not run before the configured UTC hour', async () => {
    let runs = 0;
    await runEvalSchedulerTick(
      async () => {
        runs += 1;
      },
      { enabled: true, hourUtc: 3 },
      at('2026-10-07T01:00:00Z'),
    );
    expect(runs).toBe(0);
  });

  it('runs once per UTC day', async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      await EvalRunRecord.create({ startedAt: at('2026-10-07T00:01:00Z'), status: 'done' });
    };
    await runEvalSchedulerTick(run, opts, at('2026-10-07T00:30:00Z'));
    await runEvalSchedulerTick(run, opts, at('2026-10-07T12:00:00Z'));
    expect(runs).toBe(1);
    // Next day runs again.
    await runEvalSchedulerTick(run, opts, at('2026-10-08T00:30:00Z'));
    expect(runs).toBe(2);
  });
});

describe('startEvalScheduler (#225)', () => {
  afterEach(() => {
    stopEvalScheduler();
    jest.useRealTimers();
  });

  it('does not arm the timer when disabled', () => {
    const timer = startEvalScheduler(async () => {}, { enabled: false });
    expect(timer).toBeNull();
    expect(isEvalSchedulerRunning()).toBe(false);
  });

  it('arms, runs on the tick, and does not stack a slow run', async () => {
    jest.useFakeTimers();
    let runs = 0;
    let ranToday = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startEvalScheduler(
      async () => {
        runs += 1;
        await gate;
        ranToday = true;
      },
      {
        enabled: true,
        tickMs: 1000,
        reclaimStaleRuns: async () => {},
        hasRun: async () => ranToday,
      },
    );
    expect(isEvalSchedulerRunning()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    // The first run is still in flight; further ticks are skipped.
    await jest.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(1);
    release();
    await jest.advanceTimersByTimeAsync(1000);
    // ranToday is now set, so the idempotency check skips the second tick.
    expect(runs).toBe(1);
  });

  it('swallows a run failure', async () => {
    jest.useFakeTimers();
    startEvalScheduler(
      async () => {
        throw new Error('boom');
      },
      {
        enabled: true,
        tickMs: 1000,
        reclaimStaleRuns: async () => {},
        hasRun: async () => false,
      },
    );
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();
  });
});

describe('reclaimStaleEvalRuns (#225)', () => {
  it('settles only stranded running rows older than the window', async () => {
    const stale = await EvalRunRecord.create({
      startedAt: new Date(Date.now() - STALE_EVAL_RUNNING_MS - 1000),
      status: 'running',
    });
    const fresh = await EvalRunRecord.create({ startedAt: new Date(), status: 'running' });
    const done = await EvalRunRecord.create({ startedAt: new Date(0), status: 'done' });

    const reclaimed = await reclaimStaleEvalRuns();
    expect(reclaimed).toBe(1);
    expect((await EvalRunRecord.findById(stale._id))?.status).toBe('error');
    expect((await EvalRunRecord.findById(fresh._id))?.status).toBe('running');
    expect((await EvalRunRecord.findById(done._id))?.status).toBe('done');
  });
});
