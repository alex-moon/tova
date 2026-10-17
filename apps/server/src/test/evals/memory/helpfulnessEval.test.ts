import type { WorkspaceSlice } from '../../../main/services/workspaceRetrievalService';
import {
  buildJudgePrompt,
  helpfulnessMetrics,
  normaliseFact,
  resolveSwappedOutcome,
  runHelpfulnessEval,
  runJudgePreflight,
  type HelpfulnessCaseResult,
} from '../../../main/evals/memory/helpfulnessEval';
import type { MemoryScenario } from '../../../main/evals/memory/types';

/* Stage-3 logic with injected dependencies (no Mongo/provider/judge): the swap fold, blinded prompt, metric arithmetic, and the two-arm runner loop. */
// @see #289

describe('resolveSwappedOutcome (#289)', () => {
  it('counts only an order-consistent win as a win', () => {
    expect(resolveSwappedOutcome('A', 'B')).toBe('win');
  });

  it('counts an order-consistent loss as a loss', () => {
    expect(resolveSwappedOutcome('B', 'A')).toBe('loss');
  });

  it('collapses a position flip to a tie (weak judge cannot be flattered)', () => {
    expect(resolveSwappedOutcome('A', 'A')).toBe('tie');
    expect(resolveSwappedOutcome('B', 'B')).toBe('tie');
  });

  it('treats any judge tie as a tie', () => {
    expect(resolveSwappedOutcome('tie', 'B')).toBe('tie');
    expect(resolveSwappedOutcome('A', 'tie')).toBe('tie');
    expect(resolveSwappedOutcome('tie', 'tie')).toBe('tie');
  });

  it('marks a pair with an errored presentation as an error, not a tie', () => {
    expect(resolveSwappedOutcome('error', 'B')).toBe('error');
    expect(resolveSwappedOutcome('A', 'error')).toBe('error');
    expect(resolveSwappedOutcome('error', 'error')).toBe('error');
  });
});

describe('normaliseFact (#289 T14a)', () => {
  it('collapses whitespace so a fact split by a newline still matches', () => {
    expect(normaliseFact('Twelve   thousand\npounds')).toBe('twelve thousand pounds');
  });

  it('does not match a genuinely absent fact after normalisation', () => {
    const fact = normaliseFact('community paediatrician');
    expect(normaliseFact('I have nothing on that.').includes(fact)).toBe(false);
  });
});

describe('buildJudgePrompt (#289)', () => {
  it('is blinded — it never names the block, memory, or an arm', () => {
    const prompt = buildJudgePrompt('What did we decide?', 'with answer', 'without answer');
    expect(prompt).toContain('What did we decide?');
    expect(prompt).toContain('with answer');
    expect(prompt).toContain('without answer');
    for (const leak of ['workspace', 'memory', 'inject', 'block', 'context block']) {
      expect(prompt.toLowerCase()).not.toContain(leak);
    }
  });

  it('pins the specificity-beats-fluency criterion (owner decision, judge-probe 2026-10-14)', () => {
    const prompt = buildJudgePrompt('q', 'a', 'b').toLowerCase();
    expect(prompt).toContain('specific information');
    expect(prompt).toContain('even if it is terser');
    expect(prompt).toContain('is not more helpful');
  });
});

describe('helpfulnessMetrics (#289)', () => {
  const row = (over: Partial<HelpfulnessCaseResult>): HelpfulnessCaseResult => ({
    scenarioId: 's',
    category: 'direct',
    expectedSliceId: 'seed',
    blockCarriesId: true,
    factInBlock: true,
    factHitWith: true,
    counterfactualHit: false,
    outcome: 'win',
    ...over,
  });

  it('scores ties as half a win and splits the rates', () => {
    const metrics = helpfulnessMetrics([
      row({}),
      row({ outcome: 'loss' }),
      row({ outcome: 'tie' }),
      row({ outcome: null, blockCarriesId: false, factInBlock: false, factHitWith: false }),
    ]);
    expect(metrics.total).toBe(4);
    expect(metrics.judged).toBe(3);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.ties).toBe(1);
    expect(metrics.winRate).toBeCloseTo((1 + 0.5) / 3);
    expect(metrics.blockIdRate).toBeCloseTo(3 / 4);
    expect(metrics.factHitRate).toBeCloseTo(3 / 4);
  });

  it('reports null win-rate when nothing was judged', () => {
    const metrics = helpfulnessMetrics([row({ outcome: null })]);
    expect(metrics.judged).toBe(0);
    expect(metrics.winRate).toBeNull();
  });

  it('counts errors separately and excludes them from the win-rate denominator', () => {
    const metrics = helpfulnessMetrics([
      row({ outcome: 'win' }),
      row({ outcome: 'loss' }),
      row({ outcome: 'error' }),
    ]);
    expect(metrics.errors).toBe(1);
    expect(metrics.judged).toBe(2);
    expect(metrics.winRate).toBe(0.5);
  });

  it('flags the counterfactual and withholds the deterministic win', () => {
    const metrics = helpfulnessMetrics([row({ counterfactualHit: true })]);
    expect(metrics.counterfactualHits).toBe(1);
    expect(metrics.deterministicWins).toBe(0);
  });

  it('counts a deterministic win when the block and answer carry the fact and the blank arm does not', () => {
    // The backbone's positive case is the signal the judge is a backstop for — count it, not just the negative case above.
    const metrics = helpfulnessMetrics([row({})]);
    expect(metrics.deterministicWins).toBe(1);
    expect(metrics.counterfactualHits).toBe(0);
  });
});

describe('runHelpfulnessEval (#289)', () => {
  const scenario = (id: string, fact: string): MemoryScenario => ({
    id,
    description: 'test',
    category: 'direct',
    seeds: [{ id: 'seed-a', kind: 'chat', title: 't', text: `the ${fact} fact`, at: '2026-01-01' }],
    query: 'what is the fact',
    expectedSliceId: 'seed-a',
    expectSurfaced: true,
    expectedFact: fact,
  });
  const slice = (text: string): WorkspaceSlice => ({
    kind: 'chat',
    id: 'real-1',
    title: 't',
    text,
    at: new Date(),
  });
  // Pacing is a live-call concern; tests must not sleep (T15d).
  const noPace = async (): Promise<void> => {};

  it('runs both arms and judges the pair blinded and position-swapped', async () => {
    const responses: Record<string, string> = { block: 'the fact is here', blank: 'I do not know' };
    const judgeCalls: string[][] = [];
    const { results, metrics } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [slice('the fact')],
      respond: async (_query, block) => ({ content: responses[block ? 'block' : 'blank'] }),
      pace: noPace,
      judge: async (_query, a, b) => {
        judgeCalls.push([a, b]);
        // First presentation (with-arm as A): pick A. Swapped: pick B (with-arm).
        return a === responses.block ? 'A' : 'B';
      },
    });
    expect(judgeCalls).toEqual([
      [responses.block, responses.blank],
      [responses.blank, responses.block],
    ]);
    expect(results[0]).toMatchObject({
      blockCarriesId: true,
      factInBlock: true,
      factHitWith: true,
      counterfactualHit: false,
      outcome: 'win',
    });
    expect(metrics.winRate).toBe(1);
  });

  it('records a counterfactual hit when the blank arm already answers correctly', async () => {
    const { results, metrics } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [slice('the fact')],
      respond: async () => ({ content: 'the fact is here' }),
      pace: noPace,
      judge: async () => 'tie',
    });
    expect(results[0].counterfactualHit).toBe(true);
    expect(results[0].factHitWith).toBe(true);
    expect(metrics.counterfactualHits).toBe(1);
    expect(metrics.deterministicWins).toBe(0);
    expect(metrics.truncated).toBe(0);
  });

  it('flags a length-stopped arm as truncated (T14f/OQ34)', async () => {
    // A truncated arm must be visible as its own count, not silently read as a backbone miss (a budget artefact, not a helpfulness one).
    const { results, metrics } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [slice('the fact')],
      respond: async (_query, block) =>
        block
          ? { content: 'the fact is', finishReason: 'length' }
          : { content: 'the fact is here', finishReason: 'stop' },
      pace: noPace,
      judge: async () => 'tie',
    });
    expect(results[0].finishReasons).toEqual({ with: 'length', without: 'stop' });
    expect(metrics.truncated).toBe(1);
  });

  it('skips the A/B when retrieval surfaced nothing (no block to inject)', async () => {
    let judged = 0;
    const { results } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [],
      respond: async (_query, block) => ({ content: block ? 'with' : 'without' }),
      pace: noPace,
      judge: async () => {
        judged += 1;
        return 'A';
      },
    });
    expect(judged).toBe(0);
    expect(results[0].outcome).toBeNull();
    expect(results[0].blockCarriesId).toBe(false);
  });

  it('does not pay for a second responder call when there is no block to inject', async () => {
    // With no block the two arms are byte-identical, so the runner reuses the with-arm answer; a regression would double stage-3 cost.
    let respondCalls = 0;
    const { results } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [],
      respond: async () => {
        respondCalls += 1;
        return { content: 'nothing on that' };
      },
      pace: noPace,
      judge: async () => 'A',
    });
    expect(respondCalls).toBe(1);
    expect(results[0].outcome).toBeNull();
  });

  it('records a thrown judge error as an error outcome and does not abort the run', async () => {
    const { results, metrics } = await runHelpfulnessEval({
      scenarios: [scenario('s1', 'fact')],
      clear: async () => {},
      seed: async () => ({ 'seed-a': 'real-1' }),
      retrieve: async () => [slice('the fact')],
      respond: async (_query, block) => ({ content: block ? 'the fact is here' : 'I do not know' }),
      pace: noPace,
      judge: async () => {
        throw new Error('429 rate limited');
      },
    });
    expect(results[0].outcome).toBe('error');
    expect(metrics.errors).toBe(1);
    expect(metrics.judged).toBe(0);
    expect(metrics.winRate).toBeNull();
  });

  it('clears fixtures in a finally when the responder throws (T14e)', async () => {
    let clears = 0;
    let calls = 0;
    await expect(
      runHelpfulnessEval({
        scenarios: [scenario('s1', 'fact'), scenario('s2', 'fact')],
        clear: async () => {
          clears += 1;
        },
        seed: async () => ({ 'seed-a': 'real-1' }),
        retrieve: async () => [slice('the fact')],
        respond: async () => {
          calls += 1;
          // s1 makes two responder calls (with + blank); s2's first call throws.
          if (calls === 3) throw new Error('provider down');
          return { content: 'the fact is here' };
        },
        pace: noPace,
        judge: async () => 'A',
      }),
    ).rejects.toThrow('provider down');
    // One clear per scenario start (2) plus the finally clear (1).
    expect(clears).toBe(3);
  });

  it('clears fixtures in a finally when seeding throws (T14e)', async () => {
    // A thrown seed must not leak the partially-seeded scenario under the shared `evalUserId` — the same leak class as the responder-throw case.
    let clears = 0;
    await expect(
      runHelpfulnessEval({
        scenarios: [scenario('s1', 'fact')],
        clear: async () => {
          clears += 1;
        },
        seed: async () => {
          throw new Error('mongo down');
        },
        retrieve: async () => [slice('the fact')],
        respond: async () => ({ content: 'the fact is here' }),
        pace: noPace,
        judge: async () => 'A',
      }),
    ).rejects.toThrow('mongo down');
    // One clear at the scenario start, one in the finally.
    expect(clears).toBe(2);
  });
});

describe('runJudgePreflight (#289 T14d)', () => {
  it('passes when the judge returns a parseable verdict in both orders', async () => {
    const { first, second } = await runJudgePreflight(async (_q, a) =>
      a.includes('Canberra') ? 'A' : 'B',
    );
    expect(first).toBe('A');
    expect(second).toBe('B');
  });

  it('throws when a presentation is unparseable (truncated or dead judge)', async () => {
    await expect(runJudgePreflight(async () => 'error')).rejects.toThrow(/preflight failed/);
  });
});
