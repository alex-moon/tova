import type { Client } from 'langsmith';
import type { WorkspaceSlice } from '../../services/workspaceRetrievalService';
import {
  gateMetrics,
  MEMORY_DATASET_NAME,
  pushMemoryCorpusToLangSmith,
  retrievalMetrics,
  runGateEval,
  runRetrievalEval,
  type GateCaseResult,
  type RetrievalCaseResult,
} from './memoryEvalService';
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
  it('compares the workspace vote to the hand label', async () => {
    const { results, metrics } = await runGateEval({
      gateCases: [
        { id: 'a', prompt: 'recall', refersBack: true },
        { id: 'b', prompt: 'fresh', refersBack: false },
      ],
      classify: async (prompt) => ({ files: false, workspace: prompt === 'recall' }),
    });
    expect(results.map((r) => r.pass)).toEqual([true, true]);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
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
});

describe('pushMemoryCorpusToLangSmith (#289)', () => {
  it('creates the dataset when absent and writes one example per case', async () => {
    const created: string[] = [];
    const client = {
      hasDataset: jest.fn().mockResolvedValue(false),
      createDataset: jest.fn().mockResolvedValue({ id: 'ds' }),
      createExample: jest.fn(
        async (input: unknown, _output: unknown, opts?: { datasetName: string }) => {
          created.push(opts?.datasetName ?? '');
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
      [{ id: 'g1', prompt: 'p', refersBack: true }],
    );

    expect((client as unknown as { createDataset: jest.Mock }).createDataset).toHaveBeenCalledWith(
      MEMORY_DATASET_NAME,
    );
    expect(created).toEqual([MEMORY_DATASET_NAME, MEMORY_DATASET_NAME]);
  });
});
