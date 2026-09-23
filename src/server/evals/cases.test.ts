import { CASES, resolveExpectedContent } from './cases';

describe('#112 golden set', () => {
  it('has unique ids and non-empty prompts for every case', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASES) {
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('covers the three #112 ticket scenarios plus the built-in tool extras', () => {
    const ids = CASES.map((c) => c.id);
    expect(ids).toContain('github-readme-to-files');
    expect(ids).toContain('bupa-fertility-files');
    expect(ids).toContain('pm-announcements-web');
    expect(ids).toContain('what-time-is-it');
    expect(ids).toContain('save-notes-file');
    expect(ids).toContain('benchmaxxed-evals-web');
    expect(ids).toContain('no-sources-unanswerable');
  });

  describe('#158 refusal / hallucination cases', () => {
    const byId = Object.fromEntries(CASES.map((c) => [c.id, c]));

    it('benchmaxxed: web_search + current_datetime required, no fake-search narration allowed', () => {
      const testCase = byId['benchmaxxed-evals-web'];
      expect(testCase).toBeDefined();
      expect(testCase.assertions).toEqual([
        { type: 'tool_called', tool: 'web_search' },
        { type: 'tool_called', tool: 'current_datetime' },
        { type: 'tool_not_called', tool: 'list_files' },
        { type: 'text_not_claiming_search' },
      ]);
    });

    it('unanswerable: list_files required and the refusal wording is asserted in text', () => {
      const testCase = byId['no-sources-unanswerable'];
      expect(testCase).toBeDefined();
      const types = testCase.assertions.map((a) => a.type);
      expect(types).toContain('tool_called');
      expect(types).toContain('text_matches');
      const textMatch = testCase.assertions.find((a) => a.type === 'text_matches')!;
      // The refusal regex must accept the golden refusal wording.
      expect(
        new RegExp(textMatch.pattern, 'i').test(
          'There are no sources available about windscreen cover in your files.',
        ),
      ).toBe(true);
      // …and reject a confident invented answer.
      expect(
        new RegExp(textMatch.pattern, 'i').test(
          'Your policy covers windscreen repairs up to £500 per claim.',
        ),
      ).toBe(false);
    });
  });

  it('type-checks every assertion shape via TS narrowing (no unknown types at runtime)', () => {
    const seen = new Set(CASES.flatMap((c) => c.assertions).map((a) => a.type));
    for (const t of ['tool_called', 'tool_matching', 'tool_not_called', 'tool_sequence']) {
      expect(seen.has(t as never)).toBe(true);
    }
  });

  it('resolves @repo: markers against the injected reader and leaves literals alone', () => {
    expect(resolveExpectedContent('@repo:README.md', () => 'repo body')).toBe('repo body');
    expect(resolveExpectedContent('any literal', () => 'unused')).toBe('any literal');
  });
});
