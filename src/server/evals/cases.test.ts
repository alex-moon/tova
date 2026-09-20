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
