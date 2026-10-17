import type { Client } from 'langsmith';
import type { WorkspaceSlice } from '../../../main/services/workspaceRetrievalService';
import {
  MEMORY_DATASET_NAME,
  memoryCorpusHash,
  pushMemoryCorpusToLangSmith,
  retrievalMetrics,
  runMemoryEvals,
  runRetrievalEval,
  type RetrievalCaseResult,
} from '../../../main/evals/memory/memoryEvalService';
import type { MemoryScenario } from '../../../main/evals/memory/types';

/* Runner logic with injected dependencies (no Mongo/provider/LangSmith): retrieval metric arithmetic, the per-scenario reseed/retrieve loop, the dataset export. */
// @see #289 #310

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

  it('counts empty-after-cut cases (#305)', () => {
    const withCut = { ...row('file', false, true), cutEmpty: true };
    const without = { ...row('direct', false, true), cutEmpty: false };
    expect(retrievalMetrics([withCut, withCut, without]).cutEmpty).toBe(2);
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
    // The subtype rides the gate example, so the shareable corpus carries the same per-subtype split the local metrics report.
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

describe('runMemoryEvals stage selector (#289 T6, #310)', () => {
  it('runs only the requested stages', async () => {
    const retrievalOnly = await runMemoryEvals(
      { scenarios: [], clear: async () => {}, seed: async () => ({}), retrieve: async () => [] },
      ['retrieval'],
    );
    expect(retrievalOnly.retrieval?.metrics.total).toBe(0);
  });
});
