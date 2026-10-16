import { MEMORY_SCENARIOS } from '../../../main/evals/memory/corpus';
import { runHelpfulnessEval } from '../../../main/evals/memory/helpfulnessEval';
import { clearMemoryCorpus } from '../../../main/evals/memory/memorySource';

/*
 * #289 stage-3 integration: the two-arm loop over *real* Mongo fixtures (the
 * default seed/clear/retrieve), with only the provider calls faked. This pins
 * that the block is built from the seeded slice, both arms run, and the judge
 * is handed the arms in both orders — the live responder/judge are the only
 * pieces the unit tests cannot cover.
 */
describe('helpfulness eval integration (#289)', () => {
  afterAll(async () => {
    await clearMemoryCorpus();
  });

  it('runs both arms over a real seeded slice and judges with a position swap', async () => {
    const scenario = MEMORY_SCENARIOS.find((s) => s.id === 'retrieval-direct-partner-job')!;
    const judgeOrders: [string, string][] = [];

    const { results, metrics } = await runHelpfulnessEval({
      scenarios: [scenario],
      respond: async (_query, block) =>
        block
          ? { content: `Your partner is a ${scenario.expectedFact}.` }
          : { content: 'I have nothing on that.' },
      judge: async (_query, a, b) => {
        judgeOrders.push([a, b]);
        // A judge that always picks the first answer: with-arm-as-A wins, and
        // with-arm-as-B loses, so the fold must collapse it to a tie.
        return 'A';
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      blockCarriesId: true,
      factInBlock: true,
      factHitWith: true,
      counterfactualHit: false,
      outcome: 'tie',
      verdicts: ['A', 'A'],
    });
    // Same answers, opposite order — the swap is real.
    expect(judgeOrders[0][0]).toContain('partner is a');
    expect(judgeOrders[1][0]).toContain('nothing on that');
    expect(metrics.judged).toBe(1);
    expect(metrics.ties).toBe(1);
  });
});
