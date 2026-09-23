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
  /**
   * The assistant's final answer text, accumulated from `chunk.delta` while
   * streaming (#158). Regex assertions over this are the deterministic slice
   * of the refusal/hallucination checks.
   */
  finalText?: string;
}

export type Assertion =
  | { type: 'tool_called'; tool: string; argsSubset?: Record<string, unknown> }
  | {
      type: 'tool_matching';
      /** Substring match, for fuzzy MCP tool names (#112). */ nameContains: string;
    }
  | { type: 'tool_not_called'; tool: string }
  | { type: 'tool_sequence'; tools: string[] }
  | { type: 'content_equals'; expected: string }
  | { type: 'prompt_contains'; text: string }
  /**
   * #158: the final answer must match the (case-insensitive-by-default)
   * regex — e.g. the explicit "no sources available" refusal wording.
   */
  | { type: 'text_matches'; pattern: string; flags?: string }
  /**
   * #158 hallucination guard: the final answer must NOT claim a search
   * happened unless a `web_search` call is actually present in the run.
   * The search-claim regex set lives in `graders.ts` (`SEARCH_CLAIMS`).
   */
  | { type: 'text_not_claiming_search' };

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
