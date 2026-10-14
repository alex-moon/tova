import {
  constructedJudgeLabels,
  handJudgeLabels,
  judgeAgreement,
  type JudgeLabel,
  type JudgeLabelClass,
} from './judgeValidation';
import type { JudgeVerdict } from './helpfulnessEval';
import type { MemoryScenario } from './types';

/*
 * #289 T5 judge-validation logic, exercised with an injected fake judge so no
 * provider or Mongo is needed: the constructed-pair construction, the three-class
 * accuracy/kappa arithmetic, the error exclusion, and the absent-class null.
 */

const label = (id: string, better: JudgeLabelClass): JudgeLabel => ({
  id,
  query: 'q',
  answerA: 'a',
  answerB: 'b',
  better,
  provenance: 'constructed',
});
const seqJudge = (verdicts: JudgeVerdict[]) => async (): Promise<JudgeVerdict> => {
  const next = verdicts.shift();
  if (next === undefined) throw new Error('judge called more times than expected');
  return next;
};

const noPace = async (): Promise<void> => {};
const scenario = (id: string, expectedFact: string): MemoryScenario => ({
  id,
  description: 'test',
  category: 'direct',
  seeds: [{ id: 'seed', kind: 'chat', title: 't', text: expectedFact, at: '2026-01-01' }],
  query: `what about ${id}?`,
  expectedSliceId: 'seed',
  expectSurfaced: true,
  expectedFact,
});

describe('constructedJudgeLabels (#289 T5)', () => {
  it('builds one pair per scenario with the fact in the known-good arm, alternating sides', () => {
    const labels = constructedJudgeLabels([
      scenario('a', 'alpha fact'),
      scenario('b', 'beta fact'),
    ]);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({
      id: 'constructed-a',
      better: 'A',
      provenance: 'constructed',
    });
    expect(labels[1]).toMatchObject({
      id: 'constructed-b',
      better: 'B',
      provenance: 'constructed',
    });
    // The good arm carries the expected fact; the bad arm does not.
    expect(labels[0].answerA).toContain('alpha fact');
    expect(labels[0].answerB).not.toContain('alpha fact');
    expect(labels[1].answerB).toContain('beta fact');
    expect(labels[1].answerA).not.toContain('beta fact');
  });
});

describe('judgeAgreement (#289 T5)', () => {
  it('scores a perfect judge at accuracy 1 and kappa 1', async () => {
    const labels = [label('1', 'A'), label('2', 'B'), label('3', 'tie')];
    const result = await judgeAgreement(labels, seqJudge(['A', 'B', 'tie']), noPace);
    expect(result).toMatchObject({ n: 3, errors: 0, accuracy: 1, kappa: 1 });
  });

  it("computes Cohen's kappa over the three classes (known value)", async () => {
    // 6 labels, 5 exact matches; marginals give pe = 1/3, so kappa = 0.75.
    const labels = [
      label('1', 'A'),
      label('2', 'A'),
      label('3', 'B'),
      label('4', 'B'),
      label('5', 'tie'),
      label('6', 'tie'),
    ];
    const result = await judgeAgreement(
      labels,
      seqJudge(['A', 'A', 'B', 'A', 'tie', 'tie']),
      noPace,
    );
    expect(result.n).toBe(6);
    expect(result.accuracy).toBeCloseTo(5 / 6);
    expect(result.kappa).toBeCloseTo(0.75);
  });

  it('reports a constant-A judge as low-accuracy, zero-kappa (position bias)', async () => {
    const labels = [label('1', 'A'), label('2', 'B'), label('3', 'tie')];
    const result = await judgeAgreement(labels, seqJudge(['A', 'A', 'A']), noPace);
    expect(result.accuracy).toBeCloseTo(1 / 3);
    expect(result.kappa).toBeCloseTo(0);
    expect(result.confusion.A.A).toBe(1);
    expect(result.confusion.B.A).toBe(1);
    expect(result.confusion.tie.A).toBe(1);
  });

  it('counts judge errors separately and excludes them from n/accuracy', async () => {
    const labels = [label('1', 'A'), label('2', 'A')];
    const result = await judgeAgreement(labels, seqJudge(['A', 'error']), noPace);
    expect(result).toMatchObject({ n: 1, errors: 1, accuracy: 1 });
    expect(result.confusion.A.error).toBe(1);
  });

  it('returns null kappa when a label class is absent', async () => {
    const labels = [label('1', 'A'), label('2', 'B')];
    const result = await judgeAgreement(labels, seqJudge(['A', 'B']), noPace);
    expect(result.n).toBe(2);
    expect(result.kappa).toBeNull();
  });

  it('records a thrown judge call as an error instead of aborting', async () => {
    const labels = [label('1', 'A'), label('2', 'A')];
    let calls = 0;
    const result = await judgeAgreement(
      labels,
      async () => {
        calls += 1;
        if (calls === 2) throw new Error('groq 429');
        return 'A';
      },
      noPace,
    );
    expect(result).toMatchObject({ n: 1, errors: 1, accuracy: 1 });
    expect(result.confusion.A.error).toBe(1);
  });
});

describe('handJudgeLabels (#289 T5)', () => {
  it('is a well-formed seed with all three classes and agent-authored provenance', () => {
    expect(handJudgeLabels.length).toBeGreaterThanOrEqual(12);
    const ids = handJudgeLabels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const classes = new Set(handJudgeLabels.map((l) => l.better));
    expect(classes).toEqual(new Set(['A', 'B', 'tie']));
    for (const l of handJudgeLabels) {
      expect(l.provenance).toBe('agent-authored');
      expect(l.answerA.length).toBeGreaterThan(0);
      expect(l.answerB.length).toBeGreaterThan(0);
      expect(l.answerA).not.toBe(l.answerB);
    }
  });
});
