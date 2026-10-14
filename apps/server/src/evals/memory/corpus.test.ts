import { promptWords } from '../../services/workspaceRetrievalService';
import { GATE_CASES, MEMORY_SCENARIOS } from './corpus';

/*
 * #289 corpus invariants. The corpus is data, so these tests are the guardrails
 * that keep it well-formed: unique ids, resolvable expected seeds, a labelled
 * gate set, and the two structural claims the categories make (the paraphrase
 * case really shares no content word, and only `out-of-pool` carries filler).
 */
describe('memory corpus (#289)', () => {
  it('gate cases have unique ids and both labels present', () => {
    const ids = GATE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GATE_CASES.some((c) => c.refersBack)).toBe(true);
    expect(GATE_CASES.some((c) => !c.refersBack)).toBe(true);
  });

  it('gate set clears the minimum-N bar with both labels well represented', () => {
    // A percentage over single digits is noise; the plan's provisional bar is
    // >= 30 cases with >= 12 of each label before a threshold is ratified.
    expect(GATE_CASES.length).toBeGreaterThanOrEqual(30);
    const positives = GATE_CASES.filter((c) => c.refersBack).length;
    const negatives = GATE_CASES.filter((c) => !c.refersBack).length;
    expect(positives).toBeGreaterThanOrEqual(12);
    expect(negatives).toBeGreaterThanOrEqual(12);
  });

  it('has history-only positives and history-bearing negatives', () => {
    // A continuation's refer-back lives only in the transcript, so it must
    // carry `history`; conversely a fresh ask can follow history without
    // referring back, so history alone must not imply a positive.
    expect(GATE_CASES.some((c) => c.refersBack && (c.history?.length ?? 0) > 0)).toBe(true);
    expect(GATE_CASES.some((c) => !c.refersBack && (c.history?.length ?? 0) > 0)).toBe(true);
  });

  it('scenarios have unique ids, resolvable expected seeds, and a fact', () => {
    const ids = MEMORY_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of MEMORY_SCENARIOS) {
      expect(scenario.seeds.some((seed) => seed.id === scenario.expectedSliceId)).toBe(true);
      expect(scenario.expectedFact.trim().length).toBeGreaterThan(0);
      expect(scenario.query.trim().length).toBeGreaterThan(0);
      const seedIds = scenario.seeds.map((seed) => seed.id);
      expect(new Set(seedIds).size).toBe(seedIds.length);
    }
  });

  it('the paraphrase scenario shares no content word between query and seed', () => {
    const scenario = MEMORY_SCENARIOS.find((s) => s.category === 'paraphrase');
    expect(scenario).toBeDefined();
    const queryWords = promptWords(scenario!.query);
    for (const seed of scenario!.seeds) {
      const overlap = [...promptWords(seed.text)].filter((word) => queryWords.has(word));
      expect(overlap).toEqual([]);
    }
  });

  it('only the out-of-pool scenario carries pool filler', () => {
    for (const scenario of MEMORY_SCENARIOS) {
      if (scenario.category === 'out-of-pool') expect(scenario.poolFill).toBeGreaterThan(200);
      else expect(scenario.poolFill ?? 0).toBe(0);
    }
  });
});
