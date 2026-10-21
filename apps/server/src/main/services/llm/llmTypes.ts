/* Provider-neutral LLM result types; provider shapes cannot leak. */

import type { z } from 'zod';

/* Provider toggle on options; un-tagged callers default to groq. */
// @see #151 #4 #387
export type LlmProvider = 'groq' | 'deepinfra' | 'fireworks';

/* LangSmith tracing context: identifiers only, never user content or PII. */
// @see #5
export interface TraceContext {
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/* Multimodal content parts; the image part carries a presigned URL. */
// @see #115
export type MessageContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface CompletionOptions {
  provider?: LlmProvider;
  model: string;
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: string | MessageContentPart[];
  }[];
  /* Calling user id; built-in tools scope execution per user. */
  // @see #58
  userId?: string;
  /* Calling session id for provenance tools, independent of tracing. */
  // @see #252
  sessionId?: string;
  /* Calling task id so provenance tools can attribute files. */
  // @see #298
  taskId?: string;
  temperature?: number;
  max_tokens?: number;
  /* Cap on the agent's own tool loop (task path pins 1). */
  // @see #254 #251
  maxSteps?: number;
  /* Force the agent to call tools; task steps pin 'required'. */
  // @see #387
  toolUse?: 'required';
  /* Client-disconnect signal wired by the chat routes. */
  abortSignal?: AbortSignal;
  trace?: TraceContext;
  /* Schema-enforced output; the connector returns it via `object`. */
  // @see #368
  structuredOutput?: StructuredOutputConfig<unknown>;
}

/* Structured-output request; validation failure uses `fallbackValue`. */
// @see #368
export interface StructuredOutputConfig<T> {
  schema: z.ZodType<T>;
  fallbackValue: T;
  jsonPromptInjection?: boolean | 'auto';
  errorStrategy: 'fallback';
}

/* Token usage across providers; absent (unknown) is distinct from 0. */
// @see #224 #199
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface NeutralCompletion {
  choices: Array<{
    message?: {
      content?: string | null;
    };
    /** Why the provider stopped; absent when nothing was reported. */
    finishReason?: string;
  }>;
  /** Every completed tool call on this response with its structured result. */
  // @see #16
  toolResults?: Array<{ name: string; result: unknown; args?: Record<string, unknown> }>;
  /** Token usage for the turn; absent when the provider reported nothing. */
  // @see #224
  usage?: TokenUsage;
  /** Validated structured output when `structuredOutput` is set. */
  // @see #368
  object?: unknown;
}

export interface NeutralStreamChunk {
  delta?: string | null;
  /** Emitted when the agent decides to call a tool. */
  toolCall?: {
    name: string;
    /** Structured arguments when the provider surfaces them. */
    // @see #33
    args?: Record<string, unknown>;
  };
  /** Emitted when a tool finishes, with its structured result. */
  toolResult?: { name: string; result: unknown };
  /** Emitted once after the stream drains, carrying the turn's token usage. */
  // @see #224
  usage?: TokenUsage;
}

export type NeutralChunkStream = AsyncIterable<NeutralStreamChunk>;

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  createStreamingCompletion(options: CompletionOptions): Promise<NeutralChunkStream>;
  /** Completion on a tool-free agent for aux callers. */
  // @see #41
  createToolFreeCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  /** Overload: with `structuredOutput`, the typed `object` is returned. */
  // @see #368
  createToolFreeCompletion<T>(
    options: CompletionOptions & { structuredOutput: StructuredOutputConfig<T> },
  ): Promise<NeutralCompletion & { object: T }>;
}
