import type { Assertion, EvalRun, AssertionResult, Score } from './types';

const argsMatch = (call: { args?: Record<string, unknown> }, subset?: Record<string, unknown>) => {
  if (!subset) return true;
  return Object.entries(subset).every(([key, value]) => call.args?.[key] === value);
};

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
    case 'content_equals':
      return (
        typeof run.generatedContent === 'string' && run.generatedContent === assertion.expected
      );
    case 'prompt_contains':
      return run.prompt.includes(assertion.text);
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
