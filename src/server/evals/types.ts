/**
 * Types for the #112 deterministic eval framework. Graders are code, not
 * LLM-judges: each eval case declares assertions over an observed run
 * (tool-call records, assembled prompt, produced content) and a deterministic
 * aggregator maps assertion results to pass/partial/fail.
 */

/** One observed tool call, shaped after FullOutput.toolResults plus stream args. */
export interface ToolCallRecord {
  name: string;
  /** Substring equality against a (stringified) tool result, when present. */
  result?: unknown;
  /** Only the scalar args exposed by the neutral stream are compared. */
  args?: Record<string, unknown>;
}

/** A completed eval run the graders score against. */
export interface EvalRun {
  /** Tool calls in execution order. */
  toolCalls: ToolCallRecord[];
  /** The fully assembled system+user prompt sent to the model. */
  prompt: string;
  /** Content extracted from generated files (README case), if any. */
  generatedContent?: string;
}

export type Assertion =
  | { type: 'tool_called'; tool: string; argsSubset?: Record<string, unknown> }
  | { type: 'tool_not_called'; tool: string }
  | { type: 'tool_sequence'; tools: string[] }
  | { type: 'content_equals'; expected: string }
  | { type: 'prompt_contains'; text: string };

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
}

export type Score = 'pass' | 'partial' | 'fail';

export interface EvalResult {
  caseId: string;
  score: Score;
  assertions: AssertionResult[];
}
