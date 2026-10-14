import { EvalRunBusyError } from './evalRunService';
import type { MemoryEvalReport } from '../evals/memory/memoryEvalService';
import {
  beginMemoryEvalRun,
  executeMemoryEvalRun,
  startMemoryEvalRun,
  type MemoryEvalRunDeps,
} from './memoryEvalRunService';

/*
 * #289 T6: the persisted memory rollup, exercised with injected fakes so no
 * Mongo or provider is needed — the record shape, the sentinel per-case rows,
 * the continuous metrics payload, the global lease, and the error settle.
 */

const report: MemoryEvalReport = {
  gate: {
    results: [
      { caseId: 'g1', expected: true, observed: true, pass: true, subtype: 'explicit' },
      { caseId: 'g2', expected: false, observed: false, pass: true },
    ],
    metrics: {
      total: 2,
      evaluated: 2,
      truePos: 1,
      falsePos: 0,
      trueNeg: 1,
      falseNeg: 0,
      precision: 1,
      recall: 1,
      fireRate: 0.5,
      errors: 0,
      timeouts: 0,
      recallBySubtype: { explicit: { total: 1, truePos: 1, falseNeg: 0, recall: 1 } },
    },
  },
  retrieval: {
    results: [
      {
        scenarioId: 's1',
        category: 'direct',
        expected: true,
        surfaced: true,
        pass: true,
        expectedSliceId: 'seed',
        surfacedIds: ['real'],
      },
    ],
    metrics: {
      total: 1,
      surfaced: 1,
      expectedMet: 1,
      expectedMetRate: 1,
      surfacedRate: 1,
      byCategory: { direct: { total: 1, surfaced: 1, expectedMet: 1 } },
    },
  },
};

const fakeDeps = (over: Partial<MemoryEvalRunDeps> = {}): MemoryEvalRunDeps => ({
  run: async () => report,
  createRecord: (async (doc: unknown) => ({ _id: 'id-1', ...(doc as object) })) as never,
  findRunning: async () => null,
  updateRecord: async () => undefined,
  ...over,
});

describe('beginMemoryEvalRun (#289 T6)', () => {
  it('writes a running memory lease with sentinel models and stages', async () => {
    const createRecord = jest.fn(async (doc: unknown) => ({ _id: 'id-1', ...(doc as object) }));
    const id = await beginMemoryEvalRun(
      { stages: ['retrieval'], trigger: 'scheduled' },
      fakeDeps({ createRecord: createRecord as never }),
    );
    expect(id).toBe('id-1');
    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        kind: 'memory',
        models: ['memory'],
        stages: ['retrieval'],
      }),
    );
  });

  it('rejects while any run (either kind) is live — the global lease', async () => {
    await expect(
      beginMemoryEvalRun(
        { stages: ['retrieval'], trigger: 'manual' },
        fakeDeps({ findRunning: async () => ({ _id: 'other' }) }),
      ),
    ).rejects.toBeInstanceOf(EvalRunBusyError);
  });
});

describe('executeMemoryEvalRun (#289 T6)', () => {
  it('settles done with sentinel rows and the continuous metrics payload', async () => {
    const updateRecord = jest.fn(async () => undefined);
    const result = await executeMemoryEvalRun(
      'id-1',
      { stages: ['gate', 'retrieval'], trigger: 'manual' },
      fakeDeps({ updateRecord: updateRecord as never }),
    );
    expect(result).toBe(report);
    const update = updateRecord.mock.calls[0][1] as {
      $set: { status: string; results: { caseId: string; score: string }[]; metrics: unknown };
    };
    expect(update.$set.status).toBe('done');
    expect(update.$set.results.map((r) => r.caseId)).toEqual([
      'gate:g1',
      'gate:g2',
      'retrieval:s1',
    ]);
    expect(update.$set.results.every((r) => r.score === 'pass')).toBe(true);
    expect(update.$set.metrics).toMatchObject({
      stages: ['gate', 'retrieval'],
      gate: { precision: 1, recall: 1 },
      retrieval: { surfacedRate: 1 },
    });
    expect((update.$set.metrics as { corpusHash: string }).corpusHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes no gate metrics for a retrieval-only run', async () => {
    const updateRecord = jest.fn(async () => undefined);
    await executeMemoryEvalRun(
      'id-1',
      { stages: ['retrieval'], trigger: 'scheduled' },
      fakeDeps({
        run: async () => ({ retrieval: report.retrieval }),
        updateRecord: updateRecord as never,
      }),
    );
    const metrics = (
      updateRecord.mock.calls[0][1] as { $set: { metrics: Record<string, unknown> } }
    ).$set.metrics;
    expect(metrics.gate).toBeUndefined();
    expect(metrics.retrieval).toBeDefined();
  });

  it('settles error and does not throw when the runner crashes', async () => {
    const updateRecord = jest.fn(async () => undefined);
    const result = await executeMemoryEvalRun(
      'id-1',
      { stages: ['retrieval'], trigger: 'manual' },
      fakeDeps({
        run: async () => {
          throw new Error('boom');
        },
        updateRecord: updateRecord as never,
      }),
    );
    expect(result).toEqual({});
    const update = updateRecord.mock.calls[0][1] as { $set: { status: string; error: string } };
    expect(update.$set.status).toBe('error');
    expect(update.$set.error).toBe('boom');
  });
});

describe('startMemoryEvalRun (#289 T6)', () => {
  it('begins then executes', async () => {
    const { id, report: result } = await startMemoryEvalRun(
      { stages: ['retrieval'], trigger: 'manual' },
      fakeDeps(),
    );
    expect(id).toBe('id-1');
    expect(result).toBe(report);
  });
});
