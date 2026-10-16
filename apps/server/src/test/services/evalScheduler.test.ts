import { EvalRunRecord } from '../../main/models/EvalRunRecord';
import {
  hasRunForUtcDay,
  isEvalSchedulerRunning,
  reclaimStaleEvalRuns,
  runEvalSchedulerTick,
  startEvalScheduler,
  stopEvalScheduler,
  STALE_EVAL_RUNNING_MS,
  utcDayStart,
  type EvalRunKind,
  type EvalSuite,
} from '../../main/services/evalScheduler';

/*
 * #225/#289 scheduler coverage. The suites are injected so no real suite
 * executes; the shared jest setup provides the in-memory Mongo.
 */

const opts = { enabled: true, tickMs: 1000 };
const at = (iso: string) => new Date(iso);

/** A suite whose idempotency is an in-memory flag (Mongo-free tick tests). */
const memorySuite = (
  kind: EvalRunKind,
  run: () => Promise<unknown>,
  ranToday = { value: false },
): EvalSuite & { ranToday: { value: boolean } } => ({
  kind,
  hasRun: async () => ranToday.value,
  run: async () => {
    const result = await run();
    ranToday.value = true;
    return result;
  },
  ranToday,
});

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

  it('#289 T8: is kind-scoped, so one kind does not satisfy the other', async () => {
    await EvalRunRecord.create({
      startedAt: at('2026-10-07T00:05:00Z'),
      status: 'done',
      kind: 'memory',
    });
    expect(await hasRunForUtcDay(at('2026-10-07T13:45:00Z'), 'memory')).toBe(true);
    expect(await hasRunForUtcDay(at('2026-10-07T13:45:00Z'), 'tool-use')).toBe(false);
    // Omitted kind stays the legacy any-kind check.
    expect(await hasRunForUtcDay(at('2026-10-07T13:45:00Z'))).toBe(true);
  });
});

describe('runEvalSchedulerTick (#225/#289)', () => {
  it('is a no-op when disabled', async () => {
    let runs = 0;
    await runEvalSchedulerTick(
      [memorySuite('tool-use', async () => void (runs += 1))],
      { enabled: false },
      at('2026-10-07T00:30:00Z'),
    );
    expect(runs).toBe(0);
  });

  it('does not run before the configured UTC hour', async () => {
    let runs = 0;
    await runEvalSchedulerTick(
      [memorySuite('tool-use', async () => void (runs += 1))],
      { enabled: true, hourUtc: 3 },
      at('2026-10-07T01:00:00Z'),
    );
    expect(runs).toBe(0);
  });

  it('runs each suite once per UTC day', async () => {
    let toolRuns = 0;
    let memoryRuns = 0;
    const suites = [
      memorySuite('tool-use', async () => void (toolRuns += 1)),
      memorySuite('memory', async () => void (memoryRuns += 1)),
    ];
    await runEvalSchedulerTick(suites, opts, at('2026-10-07T00:30:00Z'));
    await runEvalSchedulerTick(suites, opts, at('2026-10-07T12:00:00Z'));
    expect([toolRuns, memoryRuns]).toEqual([1, 1]);
    // A new day resets each kind's gate.
    suites.forEach((s) => (s.ranToday.value = false));
    await runEvalSchedulerTick(suites, opts, at('2026-10-08T00:30:00Z'));
    expect([toolRuns, memoryRuns]).toEqual([2, 2]);
  });

  it('#289 T8: per-kind idempotency — a tool-use run does not suppress memory', async () => {
    let toolRuns = 0;
    let memoryRuns = 0;
    const suites = [
      memorySuite('tool-use', async () => void (toolRuns += 1), { value: true }),
      memorySuite('memory', async () => void (memoryRuns += 1)),
    ];
    await runEvalSchedulerTick(suites, opts, at('2026-10-07T12:00:00Z'));
    expect([toolRuns, memoryRuns]).toEqual([0, 1]);
  });

  it('#289 T8: runs the suites strictly sequentially (no overlap)', async () => {
    let active = 0;
    let maxActive = 0;
    const body = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    await runEvalSchedulerTick(
      [memorySuite('tool-use', body), memorySuite('memory', body)],
      opts,
      at('2026-10-07T12:00:00Z'),
    );
    expect(maxActive).toBe(1);
  });

  it('#289 T8: a failing suite does not block the next suite', async () => {
    let memoryRuns = 0;
    await runEvalSchedulerTick(
      [
        memorySuite('tool-use', async () => {
          throw new Error('boom');
        }),
        memorySuite('memory', async () => void (memoryRuns += 1)),
      ],
      opts,
      at('2026-10-07T12:00:00Z'),
    );
    expect(memoryRuns).toBe(1);

    let toolRuns = 0;
    await runEvalSchedulerTick(
      [
        memorySuite('memory', async () => {
          throw new Error('boom');
        }),
        memorySuite('tool-use', async () => void (toolRuns += 1)),
      ],
      opts,
      at('2026-10-08T12:00:00Z'),
    );
    expect(toolRuns).toBe(1);
  });

  it('#289 T8: a throwing idempotency check does not skip the next suite', async () => {
    // A transient Mongo error in one suite's `hasRun` must not abort the whole
    // tick (which would silently skip the next suite for the window).
    let memoryRuns = 0;
    await runEvalSchedulerTick(
      [
        {
          kind: 'tool-use',
          hasRun: async () => {
            throw new Error('mongo blip');
          },
          run: async () => undefined,
        },
        memorySuite('memory', async () => void (memoryRuns += 1)),
      ],
      opts,
      at('2026-10-07T12:00:00Z'),
    );
    expect(memoryRuns).toBe(1);
  });
});

describe('startEvalScheduler (#225)', () => {
  afterEach(() => {
    stopEvalScheduler();
    jest.useRealTimers();
  });

  it('does not arm the timer when disabled', () => {
    const timer = startEvalScheduler([], { enabled: false });
    expect(timer).toBeNull();
    expect(isEvalSchedulerRunning()).toBe(false);
  });

  it('arms, runs on the tick, and does not stack a slow run', async () => {
    jest.useFakeTimers();
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ranToday = { value: false };
    startEvalScheduler(
      [
        {
          kind: 'tool-use',
          hasRun: async () => ranToday.value,
          run: async () => {
            runs += 1;
            await gate;
            ranToday.value = true;
          },
        },
      ],
      { enabled: true, tickMs: 1000, reclaimStaleRuns: async () => {} },
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
      [
        {
          kind: 'tool-use',
          hasRun: async () => false,
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
      { enabled: true, tickMs: 1000, reclaimStaleRuns: async () => {} },
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

  it('#289 T8: a kind-scoped sweep reclaims only that kind', async () => {
    const staleMemory = await EvalRunRecord.create({
      startedAt: new Date(Date.now() - STALE_EVAL_RUNNING_MS - 1000),
      status: 'running',
      kind: 'memory',
    });
    const staleTool = await EvalRunRecord.create({
      startedAt: new Date(Date.now() - STALE_EVAL_RUNNING_MS - 1000),
      status: 'running',
      kind: 'tool-use',
    });

    expect(await reclaimStaleEvalRuns(STALE_EVAL_RUNNING_MS, 'memory')).toBe(1);
    expect((await EvalRunRecord.findById(staleMemory._id))?.status).toBe('error');
    expect((await EvalRunRecord.findById(staleTool._id))?.status).toBe('running');
  });
});
