import { evalUserId } from '../../../main/evals/mongoSource';
import {
  buildWorkspaceBlock,
  retrieveWorkspaceSlices,
} from '../../../main/services/workspaceRetrievalService';
import { MEMORY_SCENARIOS } from '../../../main/evals/memory/corpus';
import { clearMemoryCorpus, seedMemoryScenario } from '../../../main/evals/memory/memorySource';

/* Retrieval integration: seed real Mongo rows, run the real read, check whether the expected slice surfaced — pinning the deterministic outcomes the current ranker produces so a later ranking change has a diff to show. */
// @see #289 #293 #294
describe('memory corpus retrieval (#289)', () => {
  afterAll(async () => {
    await clearMemoryCorpus();
  });

  const retrieve = async (id: string) => {
    const scenario = MEMORY_SCENARIOS.find((s) => s.id === id);
    if (!scenario) throw new Error(`unknown scenario ${id}`);
    await clearMemoryCorpus();
    const idMap = await seedMemoryScenario(scenario);
    const picks = await retrieveWorkspaceSlices(scenario.query, evalUserId.toHexString());
    const expectedId = idMap[scenario.expectedSliceId];
    return { surfaced: expectedId !== undefined && picks.some((p) => p.id === expectedId), picks };
  };

  it('surfaces a direct chat seed', async () => {
    expect((await retrieve('retrieval-direct-partner-job')).surfaced).toBe(true);
  });

  it('surfaces a file seed', async () => {
    expect((await retrieve('retrieval-file-lease-pets')).surfaced).toBe(true);
  });

  it('surfaces a task seed (#298)', async () => {
    expect((await retrieve('retrieval-task-budget')).surfaced).toBe(true);
  });

  it('materialises file and task slices at the seed date (deterministic fixtures)', async () => {
    // `Asset`/`Task` are `timestamps: true`, so without pinning, wall-clock now would silently override the corpus's `at` — a trap for future recency-ordering scenarios.
    for (const id of ['retrieval-file-lease-pets', 'retrieval-task-budget']) {
      const scenario = MEMORY_SCENARIOS.find((s) => s.id === id)!;
      const seed = scenario.seeds.find((s) => s.id === scenario.expectedSliceId)!;
      const { picks } = await retrieve(id);
      const pick = picks.find((p) => p.title === seed.title);
      expect(pick?.at.toISOString()).toBe(new Date(seed.at).toISOString());
    }
  });

  // Baseline gap: the paraphrase shares no content word, so lexical overlap scores zero — the case BM25/embeddings are measured against.
  // @see #293 #294
  it('does not surface a paraphrase (lexical baseline)', async () => {
    expect((await retrieve('retrieval-paraphrase-partner')).surfaced).toBe(false);
  });

  it('does not surface a soft-deleted seed', async () => {
    expect((await retrieve('retrieval-deleted-seed')).surfaced).toBe(false);
  });

  it('surfaces a seed buried beyond the old bounded pool (#293)', async () => {
    expect((await retrieve('retrieval-out-of-pool')).surfaced).toBe(true);
  });

  it('carries the expected fact into the block exactly when the slice surfaces', async () => {
    // The block is built by `matchSnippet` under a 1200-char cap, so a fact outside the window would make stage 3's backbone unreachable (a fixture defect masquerading as a stage-3 failure); on a by-construction miss the block must be empty. Assert both agree for every scenario.
    for (const scenario of MEMORY_SCENARIOS) {
      await clearMemoryCorpus();
      const idMap = await seedMemoryScenario(scenario);
      const picks = await retrieveWorkspaceSlices(scenario.query, evalUserId.toHexString());
      const expectedId = idMap[scenario.expectedSliceId];
      const surfaced = picks.some((p) => p.id === expectedId);
      const block = buildWorkspaceBlock(scenario.query, picks);
      const factInBlock = block.toLowerCase().includes(scenario.expectedFact.toLowerCase());
      expect({ id: scenario.id, factInBlock }).toEqual({ id: scenario.id, factInBlock: surfaced });
    }
    await clearMemoryCorpus();
  });
});
