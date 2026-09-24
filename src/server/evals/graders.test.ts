import { assertRun, aggregateScore, gradeRun } from './graders';
import type { Assertion, EvalRun } from './types';

const run = (toolCalls: EvalRun['toolCalls'], extra: Partial<EvalRun> = {}): EvalRun => ({
  toolCalls,
  prompt: '',
  ...extra,
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

  it('answer_contains is a substring match on the final answer (#159)', () => {
    const run_ = run([{ name: 'read_file' }], { answer: 'The number appears on page 58 of 60.' });
    const results = assertRun(run_, [
      { type: 'answer_contains', text: 'page 58' },
      { type: 'answer_contains', text: 'page 59' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('answer_contains survives no-break spaces and casing (#159 live run)', () => {
    const run_ = run([{ name: 'read_file' }], {
      // Narrow no-break spaces (U+202F) inside the phone number, "Page" capitalised.
      answer: 'The number is **+44\u202f20\u202f7946\u202f0812**, listed on **Page\u202f58**.',
    });
    const results = assertRun(run_, [
      { type: 'answer_contains', text: '+44 20 7946 0812' },
      { type: 'answer_contains', text: 'page 58' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it('answer_contains fails when no answer was captured', () => {
    const results = assertRun(run([{ name: 'read_file' }]), [
      { type: 'answer_contains', text: '58' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([false]);
  });

  it('argsSubset matches numeric args regardless of wire encoding (#159)', () => {
    const run_ = run([
      { name: 'read_file', args: { id: 'a', unit: '58' } },
      { name: 'generate_file', args: { filename: '42-test.md', content: 'yes' } },
    ]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { unit: 58 } },
      // Non-numeric strings stay strings; a number never merges with text.
      { type: 'tool_called', tool: 'generate_file', argsSubset: { filename: '42-test.md' } },
      {
        type: 'tool_called',
        tool: 'generate_file',
        argsSubset: { filename: '042-test.md' },
      },
      // A boolean/string mismatch stays a mismatch.
      { type: 'tool_called', tool: 'read_file', argsSubset: { id: 'b' } },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, true, false, false]);
  });

  it('file_content_contains matches the exact filename and substring content (#159)', () => {
    const run_ = run(
      [
        {
          name: 'generate_file',
          args: { filename: '01-overview.md', content: '## Overview\nbody' },
        },
        { name: 'generate_file', args: { filename: '06-glossary.md', content: '## Glossary\n' } },
      ],
      {
        generatedFiles: [
          { filename: '01-overview.md', content: '## Overview\nbody' },
          { filename: '06-glossary.md', content: '## Glossary\n' },
        ],
      },
    );
    const results = assertRun(run_, [
      { type: 'file_content_contains', filename: '01-overview.md', text: '## Overview' },
      { type: 'file_content_contains', filename: '06-glossary.md', text: '## Glossary' },
      { type: 'file_content_contains', filename: '01-overview.md', text: '## Overview ' },
      { type: 'file_content_contains', filename: '02-missing.md', text: ' anything' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, true, false, false]);
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

  it('argsSubset still mismatches genuinely different values', () => {
    const run_ = run([{ name: 'read_file', args: { maxChars: 1000 } }]);
    const results = assertRun(run_, [
      { type: 'tool_called', tool: 'read_file', argsSubset: { maxChars: '2000' } },
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
