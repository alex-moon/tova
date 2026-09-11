import {
  computeDeterministicMetrics,
  computeCodeIndicators,
  computeLengthBucket,
  computeStopwordRatio,
  countWords,
  estimateAvgWordLength,
  estimateSyllablesAvg,
  hasImperative,
  hasQuestionMark,
} from './promptMetrics';

describe('Prompt Metrics (deterministic)', () => {
  describe('countWords', () => {
    it('counts simple words', () => {
      expect(countWords('hello world')).toBe(2);
    });

    it('handles punctuation and contractions', () => {
      expect(countWords("don't stop, it's fine")).toBe(4);
    });

    it('counts numbers and unicode letters', () => {
      expect(countWords('héllo wörld 123')).toBe(3);
    });
  });

  describe('lengthBucket', () => {
    it('buckets by word count thresholds', () => {
      expect(computeLengthBucket(0)).toBe('short');
      expect(computeLengthBucket(12)).toBe('short');
      expect(computeLengthBucket(13)).toBe('medium');
      expect(computeLengthBucket(59)).toBe('medium');
      expect(computeLengthBucket(60)).toBe('long');
    });
  });

  describe('estimateAvgWordLength', () => {
    it('averages word lengths', () => {
      expect(estimateAvgWordLength('hi there')).toBeCloseTo((2 + 5) / 2);
    });

    it('returns 0 for empty and whitespace-only input', () => {
      expect(estimateAvgWordLength('')).toBe(0);
      expect(estimateAvgWordLength('   \n\t ')).toBe(0);
    });
  });

  describe('estimateSyllablesAvg', () => {
    it('uses a vowel-cluster heuristic', () => {
      // "cat" = 1, "hello" = 2 -> 1.5
      expect(estimateSyllablesAvg('cat hello')).toBeCloseTo(1.5);
    });

    it('reduces silent trailing e clusters', () => {
      // "make" -> 1 syllable, "table" -> 1 (trailing e cluster removed)
      expect(estimateSyllablesAvg('make table')).toBeCloseTo(1);
      // "happy" keeps 2 clusters (no trailing e)
      expect(estimateSyllablesAvg('happy')).toBeCloseTo(2);
    });

    it('returns 0 for empty input', () => {
      expect(estimateSyllablesAvg('')).toBe(0);
    });

    it('never yields NaN on inputs without vowels', () => {
      expect(estimateSyllablesAvg('xyz grr hmm')).not.toBeNaN();
      expect(estimateSyllablesAvg('héllo wörld')).not.toBeNaN();
    });
  });

  describe('computeCodeIndicators', () => {
    it('counts fenced blocks and excludes them from inline backticks', () => {
      const text = 'look:\n```js\nconst a = 1;\n```\nand `inline` too';
      const ci = computeCodeIndicators(text);
      expect(ci.fences).toBe(2);
      expect(ci.backticks).toBe(1);
      expect(ci.codeTokenCount).toBeGreaterThanOrEqual(1); // `const`
    });

    it('counts unterminated fences, arrows, and code tokens', () => {
      const ci = computeCodeIndicators('use the => arrow and {} braces in code');
      expect(ci.fences).toBe(0);
      expect(ci.codeTokenCount).toBe(2); // => and {}
    });

    it('returns zeros for plain text and empty input', () => {
      expect(computeCodeIndicators('no code here')).toEqual({
        fences: 0,
        backticks: 0,
        codeTokenCount: 0,
      });
      expect(computeCodeIndicators('')).toEqual({
        fences: 0,
        backticks: 0,
        codeTokenCount: 0,
      });
    });

    it('handles a long code block', () => {
      const block =
        '```\n' + Array.from({ length: 50 }, (_, i) => `line ${i} = ${i};`).join('\n') + '\n```';
      const ci = computeCodeIndicators(block);
      expect(ci.fences).toBe(2);
      expect(ci.backticks).toBe(0);
    });
  });

  describe('computeStopwordRatio', () => {
    it('computes share of stopwords', () => {
      // "the cat and the dog" -> 3/5 stopwords
      expect(computeStopwordRatio('the cat and the dog')).toBeCloseTo(0.6);
    });

    it('is case-insensitive', () => {
      expect(computeStopwordRatio('The THE the')).toBeCloseTo(1);
    });

    it('returns 0 for empty or all-content words', () => {
      expect(computeStopwordRatio('')).toBe(0);
      expect(computeStopwordRatio('refactor implement')).toBe(0);
    });
  });

  describe('hasQuestionMark', () => {
    it('detects question marks', () => {
      expect(hasQuestionMark('what is this?')).toBe(true);
      expect(hasQuestionMark('do this now')).toBe(false);
      expect(hasQuestionMark('')).toBe(false);
    });
  });

  describe('hasImperative', () => {
    it('detects a leading imperative verb, case-insensitive', () => {
      expect(hasImperative('Write me a test')).toBe(true);
      expect(hasImperative('fix the bug')).toBe(true);
    });

    it('rejects non-imperative openers', () => {
      expect(hasImperative('the bug is fixed')).toBe(false);
      expect(hasImperative('')).toBe(false);
      expect(hasImperative('   ')).toBe(false);
    });
  });

  describe('computeDeterministicMetrics', () => {
    it('is total and never NaN/undefined for empty, whitespace, or unicode input', () => {
      for (const text of ['', '   \n\t ', 'héllo wörld ¿qué?']) {
        const m = computeDeterministicMetrics(text);
        expect(m.wordCount).not.toBeNaN();
        expect(m.charCount).not.toBeNaN();
        expect(m.avgWordLength).not.toBeNaN();
        expect(m.syllableEstimateAvg).not.toBeNaN();
        expect(m.stopwordRatio).not.toBeNaN();
        expect(m.lengthBucket).toMatch(/^(short|medium|long)$/);
      }
    });

    it('computes a full metrics object for a sample text', () => {
      const m = computeDeterministicMetrics('Can you fix the code?\n```js\nconst x = 1;\n```');
      expect(m.wordCount).toBeGreaterThan(0);
      expect(m.charCount).toBeGreaterThan(0);
      expect(m.hasQuestionMark).toBe(true);
      expect(m.hasImperative).toBe(false);
      expect(m.codeIndicators.fences).toBe(2);
      expect(m.lengthBucket).toBe('short');
    });
  });
});
