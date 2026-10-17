/** Types for the deterministic eval framework: code graders, not LLM judges. */
// @see #112

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
  /** The assistant's final answer text, accumulated from `chunk.delta` while streaming. */
  // @see #158
  finalText?: string;
  /** The assistant's final answer text, letting retrieval cases grade the answer itself. */
  // @see #159
  answer?: string;
  /** Every generated file emitted by the run, in call order. */
  // @see #159
  generatedFiles?: Array<{ filename: string; content: string }>;
}

export type Assertion =
  | { type: 'tool_called'; tool: string; argsSubset?: Record<string, unknown> }
  | {
      type: 'tool_matching';
      /** Substring match, for fuzzy MCP tool names. */
      // @see #112
      nameContains: string;
    }
  | { type: 'tool_not_called'; tool: string }
  | { type: 'tool_sequence'; tools: string[] }
  | { type: 'content_equals'; expected: string }
  | { type: 'prompt_contains'; text: string }
  /** The final answer must match the regex (case-insensitive by default). */
  // @see #158
  | { type: 'text_matches'; pattern: string; flags?: string }
  /** The final answer must not claim a search happened without a `web_search` call in the run. */
  // @see #158
  | { type: 'text_not_claiming_search' }
  /** A sourced answer must reference its sources inline as literal links in the final text. */
  // @see #158
  | { type: 'text_inline_sources' }
  /** Substring (case/whitespace-normalised) match on the assistant's final answer. */
  // @see #159
  | { type: 'answer_contains'; text: string }
  /** A generated file's content contains `text` with `filename` matched exactly. */
  // @see #159
  | { type: 'file_content_contains'; filename: string; text: string };

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
