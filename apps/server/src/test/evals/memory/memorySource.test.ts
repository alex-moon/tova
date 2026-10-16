import { evalUserId } from '../../../main/evals/mongoSource';
import {
  buildWorkspaceBlock,
  retrieveWorkspaceSlices,
} from '../../../main/services/workspaceRetrievalService';
import { MEMORY_SCENARIOS } from '../../../main/evals/memory/corpus';
import { clearMemoryCorpus, seedMemoryScenario } from '../../../main/evals/memory/memorySource';

/*
 * #289 retrieval integration: seed a scenario's real Mongo rows, run the real
 * retrieval read, and check whether the expected slice ID surfaced. These pin
 * the deterministic outcomes the current ranker (and the deleted filter)
 * produce, so a later ranking change (#294) has a diff to show. #293 replaced
 * the bounded-pool overlap score with whole-corpus BM25, which flips the
 * `out-of-pool` case to a hit; `paraphrase` stays a miss (lexical ranker).
 */
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
    // `Asset`/`Task` are `timestamps: true`, so without pinning the seeder would
    // stamp `createdAt`/`updatedAt` with wall-clock now and the corpus's `at`
    // would be silently ignored — a latent trap for any future scenario that
    // relies on recency ordering. Assert the slice carries the declared date.
    for (const id of ['retrieval-file-lease-pets', 'retrieval-task-budget']) {
      const scenario = MEMORY_SCENARIOS.find((s) => s.id === id)!;
      const seed = scenario.seeds.find((s) => s.id === scenario.expectedSliceId)!;
      const { picks } = await retrieve(id);
      const pick = picks.find((p) => p.title === seed.title);
      expect(pick?.at.toISOString()).toBe(new Date(seed.at).toISOString());
    }
  });

  // Baseline gap: the paraphrase shares no content word, so lexical overlap
  // scores zero. This is the case #293 (BM25) / #294 (embeddings) are measured
  // against; when either lands, this assertion flips to `true`.
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
    // Stage 3's deterministic backbone asserts the with-arm block carries the
    // expected fact. The block is built by `matchSnippet` (a 160-char window
    // centred on the prompt match) under a 1200-char cap, so a fact outside the
    // window — or pushed out when several slices compete — would make the
    // backbone unreachable even though the slice surfaced: a fixture defect
    // masquerading as a stage-3 failure. Conversely, on a by-construction miss
    // the block is empty, so the fact must be absent. Assert the two agree for
    // every scenario, not just the ones the baseline surfaces.
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
