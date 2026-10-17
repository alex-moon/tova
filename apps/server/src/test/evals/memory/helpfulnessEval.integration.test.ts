import { MEMORY_SCENARIOS } from '../../../main/evals/memory/corpus';
import { runHelpfulnessEval } from '../../../main/evals/memory/helpfulnessEval';
import { clearMemoryCorpus } from '../../../main/evals/memory/memorySource';

/* Stage-3 integration over real Mongo fixtures with only provider calls faked: the block builds from the seeded slice, both arms run, and the judge sees both orders. */
// @see #289
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
        // A judge that always picks the first answer must fold to a tie (with-arm-as-A wins, with-arm-as-B loses).
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
