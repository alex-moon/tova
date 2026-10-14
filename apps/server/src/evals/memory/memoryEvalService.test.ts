import type { Client } from 'langsmith';
import type { WorkspaceSlice } from '../../services/workspaceRetrievalService';
import {
  assertEnrichmentEnabled,
  gateMetrics,
  MEMORY_DATASET_NAME,
  memoryCorpusHash,
  pushMemoryCorpusToLangSmith,
  retrievalMetrics,
  runGateEval,
  runMemoryEvals,
  runRetrievalEval,
  type GateCaseResult,
  type RetrievalCaseResult,
} from './memoryEvalService';
import type { EnrichmentProbe } from '../../services/enrichmentService';
import type { MemoryScenario } from './types';

/*
 * #289 runner logic, exercised with injected dependencies so no Mongo, provider,
 * or LangSmith is needed: metric arithmetic, the gate comparison, the per-
 * scenario reseed/retrieve loop, and the dataset export.
 */

const gate = (expected: boolean, observed: boolean): GateCaseResult => ({
  caseId: 'x',
  expected,
  observed,
  pass: expected === observed,
});

describe('gateMetrics (#289)', () => {
  it('computes precision/recall/fire-rate from the confusion matrix', () => {
    const metrics = gateMetrics([
      gate(true, true),
      gate(true, false),
      gate(false, true),
      gate(false, false),
    ]);
    expect(metrics).toMatchObject({
      total: 4,
      truePos: 1,
      falsePos: 1,
      trueNeg: 1,
      falseNeg: 1,
      precision: 0.5,
      recall: 0.5,
      fireRate: 0.5,
    });
  });

  it('reports null precision when the gate never fires (base-rate blind)', () => {
    const metrics = gateMetrics([gate(true, false), gate(false, false)]);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBe(0);
    expect(metrics.fireRate).toBe(0);
  });

  it('reports recall per refer-back subtype, ignoring negatives', () => {
    const withSubtype = (
      subtype: GateCaseResult['subtype'],
      expected: boolean,
      observed: boolean,
    ): GateCaseResult => ({ ...gate(expected, observed), subtype });
    const metrics = gateMetrics([
      withSubtype('explicit', true, true),
      withSubtype('explicit', true, true),
      withSubtype('continuation', true, false),
      withSubtype('bare-deixis', true, true),
      gate(false, false),
    ]);
    expect(metrics.recallBySubtype.explicit).toEqual({
      total: 2,
      truePos: 2,
      falseNeg: 0,
      recall: 1,
    });
    expect(metrics.recallBySubtype.continuation).toEqual({
      total: 1,
      truePos: 0,
      falseNeg: 1,
      recall: 0,
    });
    expect(metrics.recallBySubtype['bare-deixis'].recall).toBe(1);
  });

  it('partitions the positive labels across subtypes (bucket sums match overall recall)', () => {
    // Every subtype row is a positive, so the subtype buckets must exactly
    // partition the overall tp/fn. A regression that double-counted or dropped
    // a subtype would silently move a per-subtype bar without changing overall
    // recall, so the partition is the invariant that keeps them consistent.
    const withSubtype = (
      subtype: GateCaseResult['subtype'],
      expected: boolean,
      observed: boolean,
    ): GateCaseResult => ({ ...gate(expected, observed), subtype });
    const metrics = gateMetrics([
      withSubtype('explicit', true, true),
      withSubtype('explicit', true, false),
      withSubtype('continuation', true, true),
      withSubtype('bare-deixis', true, false),
      withSubtype('bare-deixis', true, true),
      gate(false, true),
      gate(false, false),
    ]);
    const buckets = Object.values(metrics.recallBySubtype);
    const sum = (pick: (b: (typeof buckets)[number]) => number) =>
      buckets.reduce((n, b) => n + pick(b), 0);
    expect(sum((b) => b.total)).toBe(metrics.truePos + metrics.falseNeg);
    expect(sum((b) => b.truePos)).toBe(metrics.truePos);
    expect(sum((b) => b.falseNeg)).toBe(metrics.falseNeg);
  });

  it('excludes failed/timeout cases from the matrix and counts them (T15b)', () => {
    const failedRow = (timeout: boolean): GateCaseResult => ({
      caseId: 'x',
      expected: true,
      observed: false,
      pass: false,
      failed: true,
      timeout,
    });
    const metrics = gateMetrics([
      gate(true, true),
      gate(false, false),
      failedRow(false),
      failedRow(true),
    ]);
    // Only the two usable cases are scored: no false negative from the failures.
    expect(metrics.total).toBe(4);
    expect(metrics.evaluated).toBe(2);
    expect(metrics.truePos).toBe(1);
    expect(metrics.falseNeg).toBe(0);
    expect(metrics.errors).toBe(1);
    expect(metrics.timeouts).toBe(1);
    expect(metrics.recall).toBe(1);
    // fireRate is over evaluated cases, so a dead call cannot depress it.
    expect(metrics.fireRate).toBe(0.5);
  });

  it('keeps the subtype partition intact when a positive case failed (T15b x T1b-i)', () => {
    // A failed positive carries its subtype but must be excluded from *both* the
    // overall confusion matrix and the subtype buckets, or per-subtype recall
    // would diverge from overall recall. A regression that counted the failed
    // row in `recallBySubtype` but not `falseNeg` (or vice versa) would move a
    // per-subtype bar without moving overall recall, so pin the partition.
    const withSubtype = (
      subtype: GateCaseResult['subtype'],
      expected: boolean,
      observed: boolean,
    ): GateCaseResult => ({ ...gate(expected, observed), subtype });
    const metrics = gateMetrics([
      withSubtype('explicit', true, true),
      withSubtype('continuation', true, false),
      { ...withSubtype('bare-deixis', true, false), failed: true },
      gate(false, false),
    ]);
    expect(metrics.evaluated).toBe(3);
    expect(metrics.errors).toBe(1);
    expect(metrics.falseNeg).toBe(1);
    // The failed bare-deixis positive is not a false negative and not bucketed.
    expect(metrics.recallBySubtype['bare-deixis']).toBeUndefined();
    const buckets = Object.values(metrics.recallBySubtype);
    const sum = (pick: (b: (typeof buckets)[number]) => number) =>
      buckets.reduce((n, b) => n + pick(b), 0);
    expect(sum((b) => b.total)).toBe(metrics.truePos + metrics.falseNeg);
    expect(sum((b) => b.truePos)).toBe(metrics.truePos);
    expect(sum((b) => b.falseNeg)).toBe(metrics.falseNeg);
  });
});

describe('retrievalMetrics (#289)', () => {
  const row = (
    category: RetrievalCaseResult['category'],
    surfaced: boolean,
    expected: boolean,
  ): RetrievalCaseResult => ({
    scenarioId: `${category}-${surfaced}`,
    category,
    expected,
    surfaced,
    pass: surfaced === expected,
    expectedSliceId: 'seed',
    surfacedIds: [],
  });

  it('splits surfacing rate from expected-met rate and buckets by category', () => {
    const metrics = retrievalMetrics([
      row('direct', true, true),
      row('paraphrase', false, true),
      row('deleted-seed', false, false),
    ]);
    expect(metrics.total).toBe(3);
    expect(metrics.surfaced).toBe(1);
    expect(metrics.expectedMet).toBe(2);
    expect(metrics.surfacedRate).toBeCloseTo(1 / 3);
    expect(metrics.expectedMetRate).toBeCloseTo(2 / 3);
    expect(metrics.byCategory.direct).toEqual({ total: 1, surfaced: 1, expectedMet: 1 });
    expect(metrics.byCategory.paraphrase).toEqual({ total: 1, surfaced: 0, expectedMet: 0 });
  });
});

describe('runGateEval (#289)', () => {
  beforeEach(() => {
    delete process.env.ENRICHMENT_ENABLED;
  });

  const ok = (workspace: boolean): EnrichmentProbe => ({ outcome: 'ok', files: false, workspace });

  it('compares the workspace vote to the hand label', async () => {
    const { results, metrics } = await runGateEval({
      gateCases: [
        { id: 'a', prompt: 'recall', refersBack: true },
        { id: 'b', prompt: 'fresh', refersBack: false },
      ],
      classify: async (prompt) => ok(prompt === 'recall'),
    });
    expect(results.map((r) => r.pass)).toEqual([true, true]);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });

  it('records a provider error as failed, not a false negative (T15b)', async () => {
    const { results, metrics } = await runGateEval({
      gateCases: [{ id: 'a', prompt: 'recall', refersBack: true }],
      classify: async () => ({ outcome: 'error' }),
    });
    expect(results[0]).toMatchObject({ failed: true, timeout: false, observed: false });
    expect(metrics.errors).toBe(1);
    expect(metrics.falseNeg).toBe(0);
    expect(metrics.recall).toBeNull();
  });

  it('records a timeout distinctly (T15b/OQ33)', async () => {
    const { results, metrics } = await runGateEval({
      gateCases: [{ id: 'a', prompt: 'recall', refersBack: true }],
      classify: async () => ({ outcome: 'timeout' }),
    });
    expect(results[0]).toMatchObject({ failed: true, timeout: true });
    expect(metrics.timeouts).toBe(1);
    expect(metrics.errors).toBe(0);
  });

  it('paces before every gate call (T15c)', async () => {
    let paced = 0;
    await runGateEval({
      gateCases: [
        { id: 'a', prompt: 'x', refersBack: true },
        { id: 'b', prompt: 'y', refersBack: false },
      ],
      classify: async () => ok(false),
      pace: async () => {
        paced += 1;
      },
    });
    expect(paced).toBe(2);
  });

  it('throws when enrichment is disabled rather than posting a 0% gate (T15a)', async () => {
    process.env.ENRICHMENT_ENABLED = '0';
    await expect(runGateEval({ gateCases: [] })).rejects.toThrow(/ENRICHMENT_ENABLED/);
    delete process.env.ENRICHMENT_ENABLED;
  });
});

describe('assertEnrichmentEnabled (#289)', () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_ENABLED;
  });

  it('passes when enrichment is on or unset', () => {
    delete process.env.ENRICHMENT_ENABLED;
    expect(() => assertEnrichmentEnabled()).not.toThrow();
    process.env.ENRICHMENT_ENABLED = '1';
    expect(() => assertEnrichmentEnabled()).not.toThrow();
  });

  it('throws when ENRICHMENT_ENABLED=0', () => {
    process.env.ENRICHMENT_ENABLED = '0';
    expect(() => assertEnrichmentEnabled()).toThrow(/ENRICHMENT_ENABLED/);
  });
});

describe('runRetrievalEval (#289)', () => {
  const scenario: MemoryScenario = {
    id: 's1',
    description: 'test',
    category: 'direct',
    seeds: [{ id: 'seed-a', kind: 'chat', title: 't', text: 'the fact', at: '2026-01-01' }],
    query: 'the fact?',
    expectedSliceId: 'seed-a',
    expectSurfaced: true,
    expectedFact: 'fact',
  };
  const slice = (id: string): WorkspaceSlice => ({
    kind: 'chat',
    id,
    title: 't',
    text: 'the fact',
    at: new Date(),
  });

  it('reseeds per scenario and records the surfaced slice', async () => {
    let cleared = 0;
    let realId = '';
    const { results } = await runRetrievalEval({
      scenarios: [scenario],
      clear: async () => {
        cleared += 1;
      },
      seed: async () => {
        realId = 'real-1';
        return { 'seed-a': realId };
      },
      retrieve: async () => [slice(realId)],
    });
    expect(cleared).toBe(2); // once before the scenario, once at teardown
    expect(results[0].surfaced).toBe(true);
    expect(results[0].pass).toBe(true);
  });

  it('marks an expected miss as a pass and an unexpected miss as a fail', async () => {
    const { results } = await runRetrievalEval({
      scenarios: [scenario, { ...scenario, id: 's2', expectSurfaced: false }],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [],
    });
    expect(results[0]).toMatchObject({ pass: false, surfaced: false, expected: true });
    expect(results[1]).toMatchObject({ pass: true, surfaced: false, expected: false });
  });

  it('clears fixtures in a finally when retrieve throws (T14e)', async () => {
    let cleared = 0;
    let calls = 0;
    await expect(
      runRetrievalEval({
        scenarios: [scenario, { ...scenario, id: 's2' }],
        clear: async () => {
          cleared += 1;
        },
        seed: async () => ({ 'seed-a': 'real-1' }),
        retrieve: async () => {
          calls += 1;
          if (calls === 2) throw new Error('mongo down');
          return [slice('real-1')];
        },
      }),
    ).rejects.toThrow('mongo down');
    // One clear at s1 start, one at s2 start, one in the finally.
    expect(cleared).toBe(3);
  });
});

describe('pushMemoryCorpusToLangSmith (#289)', () => {
  it('creates the dataset when absent and writes one example per case', async () => {
    const created: string[] = [];
    const outputs: unknown[] = [];
    const client = {
      hasDataset: jest.fn().mockResolvedValue(false),
      createDataset: jest.fn().mockResolvedValue({ id: 'ds' }),
      createExample: jest.fn(
        async (_input: unknown, output: unknown, opts?: { datasetName: string }) => {
          created.push(opts?.datasetName ?? '');
          outputs.push(output);
        },
      ),
    } as unknown as Client;

    await pushMemoryCorpusToLangSmith(
      client,
      [
        {
          id: 's1',
          description: 'd',
          category: 'direct',
          seeds: [],
          query: 'q',
          expectedSliceId: 'seed',
          expectSurfaced: true,
          expectedFact: 'f',
        },
      ],
      [{ id: 'g1', prompt: 'p', refersBack: true, subtype: 'explicit' }],
    );

    expect((client as unknown as { createDataset: jest.Mock }).createDataset).toHaveBeenCalledWith(
      MEMORY_DATASET_NAME,
    );
    expect(created).toEqual([MEMORY_DATASET_NAME, MEMORY_DATASET_NAME]);
    // The subtype rides the gate example, so the shareable corpus carries the
    // same per-subtype split the local metrics report (T1b-i).
    expect(outputs[0]).toMatchObject({ refersBack: true, subtype: 'explicit' });
  });
});

describe('memoryCorpusHash (#289 T6/D15)', () => {
  it('is stable across property order and changes on a label edit', () => {
    const gateA = { id: 'g1', prompt: 'p', refersBack: true, subtype: 'explicit' } as const;
    const gateB = { prompt: 'p', refersBack: true, subtype: 'explicit', id: 'g1' } as const;
    // Key order must not matter (canonical JSON sorts keys).
    expect(memoryCorpusHash([gateA], [])).toBe(memoryCorpusHash([gateB], []));
    // A one-character label edit changes the hash.
    const flipped = { ...gateA, refersBack: false };
    expect(memoryCorpusHash([flipped], [])).not.toBe(memoryCorpusHash([gateA], []));
  });

  it('defaults to the shipped corpus', () => {
    expect(memoryCorpusHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('runMemoryEvals stage selector (#289 T6)', () => {
  it('runs only the requested stages', async () => {
    const retrievalOnly = await runMemoryEvals(
      { scenarios: [], clear: async () => {}, seed: async () => ({}), retrieve: async () => [] },
      ['retrieval'],
    );
    expect(retrievalOnly.gate).toBeUndefined();
    expect(retrievalOnly.retrieval?.metrics.total).toBe(0);
  });
});
