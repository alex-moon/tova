import type { Assertion, EvalRun, AssertionResult, Score } from './types';

/**
 * #159: `read_file` accepts `unit` as a number or a numeric string (models
 * routinely emit numeric tool args as strings depending on the provider's
 * JSON encoding), and the tool itself coerces digit-only strings. Args are
 * normalised on both sides of an `argsSubset` comparison so the assertion is
 * about what the call meant, not the wire encoding.
 */
export const normalizeArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      const trimmed = value.trim();
      return /^[0-9]{1,9}$/.test(trimmed) ? [key, Number(trimmed)] : [key, value];
    }),
  );

const argsMatch = (call: { args?: Record<string, unknown> }, subset?: Record<string, unknown>) => {
  if (!subset) return true;
  const callArgs = call.args ? normalizeArgs(call.args) : call.args;
  return Object.entries(subset).every(
    ([key, value]) =>
      value === callArgs?.[key] || normalizeArgs({ key: value }).key === callArgs?.[key],
  );
};

/**
 * #159 live-run finding: models emit narrow/regular no-break spaces (U+202F,
 * U+00A0) inside numbers and headings, and answer casing varies (e.g.
 * "Page 58" vs "page 58"), so a literal substring check rejects visually
 * identical answers. `answer_contains` compares over a normalised form: all
 * Unicode whitespace mapped to a single ASCII space, case-folding both sides.
 */
const normaliseAnswer = (value: string): string => value.replace(/\s/g, ' ').toLowerCase();

const evaluateAssertion = (run: EvalRun, assertion: Assertion): boolean => {
  switch (assertion.type) {
    case 'tool_called':
      return run.toolCalls.some(
        (call) => call.name === assertion.tool && argsMatch(call, assertion.argsSubset),
      );
    case 'tool_matching':
      return run.toolCalls.some((call) => call.name.includes(assertion.nameContains));
    case 'tool_not_called':
      return run.toolCalls.every((call) => call.name !== assertion.tool);
    case 'tool_sequence': {
      const observed = run.toolCalls.map((call) => call.name);
      let cursor = 0;
      return assertion.tools.every((tool) => {
        const found = observed.indexOf(tool, cursor);
        if (found === -1) return false;
        cursor = found + 1;
        return true;
      });
    }
    case 'content_equals': {
      return (
        typeof run.generatedContent === 'string' && run.generatedContent === assertion.expected
      );
    }
    case 'prompt_contains':
      return run.prompt.includes(assertion.text);
    case 'answer_contains':
      return (
        typeof run.answer === 'string' &&
        normaliseAnswer(run.answer).includes(normaliseAnswer(assertion.text))
      );
    case 'file_content_contains':
      return (
        run.generatedFiles?.some(
          (file) =>
            file.filename === assertion.filename &&
            typeof file.content === 'string' &&
            file.content.includes(assertion.text),
        ) ?? false
      );
  }
};

/** Evaluate each assertion against the run; results are always full-length. */
export const assertRun = (run: EvalRun, assertions: Assertion[]): AssertionResult[] =>
  assertions.map((assertion) => ({ assertion, passed: evaluateAssertion(run, assertion) }));

/**
 * pass = every assertion holds; fail = none; partial = anything in between.
 * Runs that produced no tool calls at all are always at best partial when
 * any tool_called assertion exists (the aggregator sees the failing
 * assertions, so this falls out naturally — an empty run never scores pass).
 */
export const aggregateScore = (results: AssertionResult[]): Score => {
  const passed = results.filter((r) => r.passed).length;
  if (passed === results.length) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
};

export const gradeRun = (
  run: EvalRun,
  assertions: Assertion[],
): { score: Score; assertions: AssertionResult[] } => {
  const results = assertRun(run, assertions);
  return { score: aggregateScore(results), assertions: results };
};
