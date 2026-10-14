import { evalUserId } from '../mongoSource';
import { retrieveWorkspaceSlices } from '../../services/workspaceRetrievalService';
import { MEMORY_SCENARIOS } from './corpus';
import { clearMemoryCorpus, seedMemoryScenario } from './memorySource';

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
});
