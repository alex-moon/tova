import { assertRun, aggregateScore, gradeRun, SEARCH_CLAIMS, NO_SOURCES_PATTERNS } from './graders';
import type { Assertion, EvalRun } from './types';

const run = (toolCalls: EvalRun['toolCalls'], extra: Partial<EvalRun> = {}): EvalRun => ({
  toolCalls,
  prompt: '',
  ...extra,
});

describe('#158 text assertions (deterministic refusal / hallucination slice)', () => {
  const noSourcesTexts = [
    'There are no relevant sources available in your files.',
    "I don't have any sources on windscreen cover.",
    "I couldn't find any relevant documents about that topic.",
    'No sources were found for that question.',
    "I'm unable to find any information about Gladiator windscreen repairs.",
  ];

  const searchClaimTexts = [
    'I did a web search on models being benchmaxxed.',
    'I performed a search of the web and found several results.',
    'After searching the web, the picture is clearer.',
    'According to my search, frontier evals need LLM judges.',
    'Ran a search for recent benchmarks to ground this.',
  ];

  it.each(noSourcesTexts)('NO_SOURCES_PATTERNS match an explicit refusal: %s', (text) => {
    expect(NO_SOURCES_PATTERNS.some((p) => p.test(text))).toBe(true);
  });

  it('NO_SOURCES_PATTERNS do not match fact-stating answers', () => {
    for (const text of [
      'Your Bupa policy covers 60% of fertility treatment costs up to £4,000.',
      'Broadband renewals come up in November.',
    ]) {
      expect(NO_SOURCES_PATTERNS.some((p) => p.test(text))).toBe(false);
    }
  });

  it.each(searchClaimTexts)('SEARCH_CLAIMS match a first-person search claim: %s', (text) => {
    expect(SEARCH_CLAIMS.some((p) => p.test(text))).toBe(true);
  });

  it('SEARCH_CLAIMS do not match quoting the user or describing the tool list', () => {
    for (const text of [
      'Should I run a web search for you on this topic?',
      'Frontier evals often use "search" in the benchmark name.',
      'Your policy refers to fertility treatment, not web searching.',
    ]) {
      expect(SEARCH_CLAIMS.some((p) => p.test(text))).toBe(false);
    }
  });

  it('text_matches passes on the final text and fails on absent finalText', () => {
    const run_ = run([], { finalText: 'No sources available, sorry.' });
    const results = assertRun(run_, [{ type: 'text_matches', pattern: 'no sources available' }]);
    expect(results.map((r) => r.passed)).toEqual([true]);
    expect(
      assertRun(run([], { finalText: 'The windscreens are covered 80%.' }), [
        { type: 'text_matches', pattern: 'no sources' },
      ]).map((r) => r.passed),
    ).toEqual([false]);
    expect(
      assertRun(run([]), [{ type: 'text_matches', pattern: 'no sources' }]).map((r) => r.passed),
    ).toEqual([false]);
  });

  it('text_matches honours custom flags (empty flags = case-sensitive)', () => {
    const run_ = run([], { finalText: 'Case Matters Here' });
    expect(
      assertRun(run_, [{ type: 'text_matches', pattern: 'case matters here', flags: '' }]).map(
        (r) => r.passed,
      ),
    ).toEqual([false]);
    expect(
      assertRun(run_, [{ type: 'text_matches', pattern: 'case matters here' }]).map(
        (r) => r.passed,
      ),
    ).toEqual([true]);
  });

  it('text_not_claiming_search fails when no search ran but the answer claims one', () => {
    const run_ = run([{ name: 'current_datetime' }], {
      finalText: searchClaimTexts[0],
    });
    const results = assertRun(run_, [{ type: 'text_not_claiming_search' }]);
    expect(results.map((r) => r.passed)).toEqual([false]);
  });

  it('text_not_claiming_search passes when no search ran and no claim is made', () => {
    const run_ = run([{ name: 'list_files' }], {
      finalText: 'Your Bupa policy covers 60% of fertility treatment.',
    });
    expect(assertRun(run_, [{ type: 'text_not_claiming_search' }]).map((r) => r.passed)).toEqual([
      true,
    ]);
  });

  it('text_not_claiming_search passes when web_search really ran, claim or not', () => {
    const run_ = run([{ name: 'web_search' }], { finalText: searchClaimTexts[3] });
    expect(assertRun(run_, [{ type: 'text_not_claiming_search' }]).map((r) => r.passed)).toEqual([
      true,
    ]);
  });

  it('text_not_claiming_search also passes on an empty run', () => {
    expect(assertRun(run([]), [{ type: 'text_not_claiming_search' }]).map((r) => r.passed)).toEqual(
      [true],
    );
  });

  it('the hallucination run scores fail via gradeRun on the golden fake-search answer', () => {
    const run_ = run([{ name: 'generate_file' }], {
      finalText: 'I did a web search about models being benchmaxxed.',
    });
    const { score, assertions } = gradeRun(run_, [
      { type: 'tool_called', tool: 'web_search' },
      { type: 'text_not_claiming_search' },
    ]);
    expect(score).toBe('fail');
    expect(assertions.map((r) => r.passed)).toEqual([false, false]);
  });

  it('the unanswerable-refusal run grades pass on the golden refusal answer', () => {
    const run_ = run([{ name: 'list_files' }], {
      finalText: 'There are no sources available about windscreen cover in your files.',
    });
    const { score, assertions } = gradeRun(run_, [
      { type: 'tool_called', tool: 'list_files' },
      {
        type: 'text_matches',
        pattern:
          '\\bno\\s+(?:relevant\\s+)?(?:sources?|information|documents)\\s+(?:are|is|were|available|found)\\b',
      },
    ]);
    expect(score).toBe('pass');
    expect(assertions.map((r) => r.passed)).toEqual([true, true]);
  });
});

describe('assertRun', () => {
  it('passes tool_called when the tool appears', () => {
    const run_ = run([
      { name: 'web_search', args: { query: 'pm announcements' } },
      { name: 'read_file', args: { path: 'bupa.md' } },
    ]);
    const results = assertRun(run_, [{ type: 'tool_called', tool: 'web_search' }]);
    expect(results.map((r) => r.passed)).toEqual([true]);
  });

  it('checks argsSubset on tool_called', () => {
    const run_ = run([{ name: 'read_file', args: { path: 'bupa.md' } }]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { path: 'bupa.md' } },
      { type: 'tool_called', tool: 'read_file', argsSubset: { path: 'cv.pdf' } },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('passes tool_not_called only when absent', () => {
    const results = assertRun(run([{ name: 'list_files' }]), [
      { type: 'tool_not_called', tool: 'web_search' },
      { type: 'tool_not_called', tool: 'list_files' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('tool_sequence requires an in-order subsequence', () => {
    const run_ = run([
      { name: 'mcp__github__repo_search' },
      { name: 'list_files' },
      { name: 'mcp__github__get_file_contents' },
    ]);
    const results = assertRun(run_, [
      {
        type: 'tool_sequence',
        tools: ['mcp__github__repo_search', 'mcp__github__get_file_contents'],
      },
      {
        type: 'tool_sequence',
        tools: ['mcp__github__get_file_contents', 'mcp__github__repo_search'],
      },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('content_equals compares generated content exactly', () => {
    const run_ = run([{ name: 'generate_file', args: { content: '# Tova' } }], {
      generatedContent: '# Tova\n',
    });
    const results = assertRun(run_, [
      { type: 'content_equals', expected: '# Tova\n' },
      { type: 'content_equals', expected: '# Tova' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('prompt_contains asserts on the assembled prompt', () => {
    const run_ = run([], { prompt: '<user:location>United Kingdom</user:location>' });
    const results = assertRun(run_, [
      { type: 'prompt_contains', text: '<user:location>' },
      { type: 'prompt_contains', text: 'France' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });
});

describe('aggregateScore', () => {
  const a = { type: 'tool_called', tool: 'web_search' } as const;

  it('scores an assertion-free run as a vacuous pass', () => {
    // Documented edge: cases must always declare assertions; this records that
    // the aggregator never crashes on an empty list.
    expect(aggregateScore(assertRun(run([]), []))).toBe('pass');
  });

  it('is pass when all assertions hold', () => {
    const run_ = run([{ name: 'web_search' }], { prompt: 'loc' });
    expect(aggregateScore(assertRun(run_, [a, { type: 'prompt_contains', text: 'loc' }]))).toBe(
      'pass',
    );
  });

  it('is fail when no assertion holds', () => {
    expect(aggregateScore(assertRun(run([]), [a]))).toBe('fail');
  });

  it('is partial when some but not all hold', () => {
    const run_ = run([{ name: 'web_search' }]);
    expect(aggregateScore(assertRun(run_, [a, { type: 'content_equals', expected: 'x' }]))).toBe(
      'partial',
    );
  });
});

describe('gradeRun', () => {
  it('combines assertions and score', () => {
    const { score, assertions } = gradeRun(run([{ name: 'list_files' }]), [
      { type: 'tool_called', tool: 'list_files' },
      { type: 'tool_called', tool: 'read_file' },
    ]);
    expect(score).toBe('partial');
    expect(assertions).toHaveLength(2);
    expect(assertions[0].passed).toBe(true);
    expect(assertions[1].passed).toBe(false);
  });
});

describe('edge cases', () => {
  it('argsSubset is a subset check — extra observed args are tolerated', () => {
    const run_ = run([{ name: 'read_file', args: { path: 'bupa.md', extra: 'noise' } }]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { path: 'bupa.md' } },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true]);
  });

  it('argsSubset compares values strictly, not loosely', () => {
    const run_ = run([{ name: 'read_file', args: { maxChars: 1000 } }]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { maxChars: '1000' } },
    ]);
    expect(results.map((r) => r.passed)).toEqual([false]);
  });

  it('argsSubset fails when a required arg key is missing', () => {
    const run_ = run([{ name: 'read_file' }]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { path: 'bupa.md' } },
    ]);
    expect(results.map((r) => r.passed)).toEqual([false]);
  });

  it('a duplicated tool in tool_sequence requires two occurrences', () => {
    const single = run([{ name: 'read_file' }]);
    const twice = run([{ name: 'read_file' }, { name: 'read_file' }]);
    const assertion: Assertion = {
      type: 'tool_sequence',
      tools: ['read_file', 'read_file'],
    };
    expect(assertRun(single, [assertion]).map((r) => r.passed)).toEqual([false]);
    expect(assertRun(twice, [assertion]).map((r) => r.passed)).toEqual([true]);
  });

  it('tool_not_called matches the full tool name including MCP prefixes', () => {
    const run_ = run([{ name: 'mcp__github__get_file_contents' }]);
    const results = assertRun(run_, [
      { type: 'tool_not_called', tool: 'get_file_contents' },
      { type: 'tool_not_called', tool: 'mcp__github__get_file_contents' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('tool_sequence tolerates unrelated calls between the expected steps', () => {
    const run_ = run([
      { name: 'current_datetime' },
      { name: 'mcp__github__get_file_contents' },
      { name: 'junk_call' },
      { name: 'generate_file' },
    ]);
    const results = assertRun(run_, [
      {
        type: 'tool_sequence',
        tools: ['mcp__github__get_file_contents', 'generate_file'],
      },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true]);
  });

  it('content_equals fails when no file was generated (undefined content)', () => {
    const run_ = run([{ name: 'generate_file' }]);
    const results = assertRun(run_, [{ type: 'content_equals', expected: '# Tova\n' }]);
    expect(results.map((r) => r.passed)).toEqual([false]);
  });

  it('prompt_contains fails on an empty toolCalls array but empty prompt string', () => {
    const results = assertRun(run([], { prompt: '' }), [{ type: 'prompt_contains', text: '' }]);
    expect(results.map((r) => r.passed)).toEqual([true]);
  });
});
