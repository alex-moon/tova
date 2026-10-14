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

  it('records a refer-back subtype on every positive and none on negatives', () => {
    // T1b-i/OQ12: a per-subtype recall bar is only possible if every positive
    // carries its subtype. Negatives are fresh asks, so they carry none.
    const subtypes = new Set(['explicit', 'continuation', 'bare-deixis']);
    for (const testCase of GATE_CASES) {
      if (testCase.refersBack) {
        expect(subtypes.has(testCase.subtype ?? '')).toBe(true);
      } else {
        expect(testCase.subtype).toBeUndefined();
      }
    }
  });

  it('pins the subtype counts so the set cannot silently rebalance', () => {
    const count = (subtype: string) => GATE_CASES.filter((c) => c.subtype === subtype).length;
    expect(count('explicit')).toBe(9);
    expect(count('continuation')).toBe(4);
    expect(count('bare-deixis')).toBe(5);
  });

  it('keeps every bare-deixis positive history-free and every continuation history-bearing', () => {
    // Bare deixis is the ambiguous subtype (OQ12): the referent is unresolvable
    // in the input the gate sees, so a bare-deictic positive must not smuggle a
    // transcript that would make it resolvable. A continuation is the opposite —
    // its refer-back lives only in the transcript, so it must carry one.
    for (const testCase of GATE_CASES) {
      if (testCase.subtype === 'bare-deixis') {
        expect(testCase.history?.length ?? 0).toBe(0);
      }
      if (testCase.subtype === 'continuation') {
        expect(testCase.history?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('has history-only positives and history-bearing negatives', () => {
    // A continuation's refer-back lives only in the transcript, so it must
    // carry `history`; conversely a fresh ask can follow history without
    // referring back, so history alone must not imply a positive.
    expect(GATE_CASES.some((c) => c.refersBack && (c.history?.length ?? 0) > 0)).toBe(true);
    expect(GATE_CASES.some((c) => !c.refersBack && (c.history?.length ?? 0) > 0)).toBe(true);
  });

  it('every gate case records its labelling source in `note`', () => {
    // T1/OQ1: label independence is only auditable if each case names who
    // labelled it. Enforce the convention so a future addition cannot silently
    // drop the provenance and quietly weaken the "hand-labelled" claim.
    for (const testCase of GATE_CASES) {
      const note = testCase.note ?? '';
      expect(note.trim().length).toBeGreaterThan(0);
      expect(/^(agent-authored|owner-confirmed)\b/.test(note)).toBe(true);
    }
  });

  it('gate cases have unique prompts (no accidental double-counting)', () => {
    // A copied case under a fresh id would double-weight one label in the
    // precision/recall denominator without showing up in the id check above.
    const prompts = GATE_CASES.map((c) => c.prompt.trim().toLowerCase());
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('scenarios have unique ids, resolvable expected seeds, and a fact', () => {
    const ids = MEMORY_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of MEMORY_SCENARIOS) {
      expect(scenario.seeds.some((seed) => seed.id === scenario.expectedSliceId)).toBe(true);
      expect(scenario.expectedFact.trim().length).toBeGreaterThan(0);
      expect(scenario.query.trim().length).toBeGreaterThan(0);
      expect(scenario.description.trim().length).toBeGreaterThan(0);
      const seedIds = scenario.seeds.map((seed) => seed.id);
      expect(new Set(seedIds).size).toBe(seedIds.length);
    }
  });

  it('marks expectSurfaced consistently with the category', () => {
    // The retrieval metric counts a case as met when `surfaced === expectSurfaced`,
    // so a scenario whose `expectSurfaced` contradicts its category silently
    // inverts its contribution to `expectedMetRate`. The hard categories are
    // expected to surface; only `deleted-seed` is a miss by construction
    // (`deletedAt`). `out-of-pool` now expects a hit: #293 searches the whole
    // corpus, so the old bounded-pool burial no longer excludes it.
    const missByConstruction = new Set(['deleted-seed']);
    for (const scenario of MEMORY_SCENARIOS) {
      expect(scenario.expectSurfaced).toBe(!missByConstruction.has(scenario.category));
    }
  });

  it('never puts the expected fact in the query (counterfactual stays valid)', () => {
    // Stage 3's without-arm is the same query with a blank block. If the query
    // already carried the expected fact, the responder could echo it without any
    // injection, the with/without arms would both "contain" it, and the A/B delta
    // would measure the query rather than the block.
    for (const scenario of MEMORY_SCENARIOS) {
      expect(scenario.query.toLowerCase()).not.toContain(scenario.expectedFact.toLowerCase());
    }
  });

  it('every paraphrase scenario shares no content word between query and seed', () => {
    // Asserted per scenario, not just the first: a paraphrase that accidentally
    // shares a keyword would be scored by lexical retrieval and stop being a
    // RAG-headroom case, silently shrinking the #293/#294 target set.
    const paraphrases = MEMORY_SCENARIOS.filter((s) => s.category === 'paraphrase');
    expect(paraphrases.length).toBeGreaterThanOrEqual(5);
    for (const scenario of paraphrases) {
      const queryWords = promptWords(scenario.query);
      for (const seed of scenario.seeds) {
        const overlap = [...promptWords(seed.text)].filter((word) => queryWords.has(word));
        expect(overlap).toEqual([]);
      }
    }
  });

  it('clears the per-category minimum-N bars', () => {
    // A percentage over a handful of cases is noise, so the plan sets a floor
    // per category before a retrieval/hit-rate threshold is treated as evidence.
    const count = (category: string) =>
      MEMORY_SCENARIOS.filter((s) => s.category === category).length;
    expect(MEMORY_SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(count('paraphrase')).toBeGreaterThanOrEqual(5);
    expect(count('file')).toBeGreaterThanOrEqual(5);
    expect(count('task')).toBeGreaterThanOrEqual(5);
    expect(count('deleted-seed')).toBeGreaterThanOrEqual(2);
    expect(count('out-of-pool')).toBeGreaterThanOrEqual(2);
  });

  it('carries the expected fact in the expected seed (stage-3 backbone is reachable)', () => {
    // Stage 3 asserts the with-arm answer contains `expectedFact`; that is only
    // a fair check if the fact the answer should echo is actually in the slice
    // retrieval is expected to surface.
    for (const scenario of MEMORY_SCENARIOS) {
      const seed = scenario.seeds.find((s) => s.id === scenario.expectedSliceId);
      expect(seed).toBeDefined();
      expect(seed!.text.toLowerCase()).toContain(scenario.expectedFact.toLowerCase());
    }
  });

  it('only the out-of-pool scenario carries pool filler', () => {
    for (const scenario of MEMORY_SCENARIOS) {
      if (scenario.category === 'out-of-pool') expect(scenario.poolFill).toBeGreaterThan(200);
      else expect(scenario.poolFill ?? 0).toBe(0);
    }
  });
});
