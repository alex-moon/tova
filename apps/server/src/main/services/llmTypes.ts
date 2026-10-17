/* Provider-neutral LLM result types shared by every inferenceService consumer; deliberately narrow so provider shapes cannot leak into call sites. */

import type { z } from 'zod';

/* Provider toggle carried on options; un-tagged callers default to groq today. */
// @see #151 #4
export type LlmProvider = 'groq' | 'deepinfra' | 'fireworks' | 'typesafe';

/* LangSmith tracing context: identifiers only, never user content or PII. */
// @see #5
export interface TraceContext {
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/* Multimodal message content: OpenAI-style content parts; the image part carries a presigned HTTPS URL the provider fetches. */
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
  /* Calling user id; rides into Mastra's request context so built-in tools can scope execution per user. */
  // @see #58
  userId?: string;
  /* Calling session id, distinct from trace.sessionId: provenance-writing tools need it independently of tracing; absent means unknown. */
  // @see #252
  sessionId?: string;
  /* Calling task id so provenance-writing tools can attribute a task-generated file to its task; absent means unknown. */
  // @see #298
  taskId?: string;
  temperature?: number;
  max_tokens?: number;
  /* Per-call cap on the agent's own tool loop: the chat path gets the connector default; the task sequencer pins 1 so one roster call is one observable driver step. */
  // @see #254 #251
  maxSteps?: number;
  /* Client-disconnect signal wired by the chat routes. */
  abortSignal?: AbortSignal;
  trace?: TraceContext;
  /* Schema-enforced output for aux calls; the connector returns the validated object via `object`. */
  // @see #368
  structuredOutput?: StructuredOutputConfig<unknown>;
}

/* Mastra structured-output request: validation failure degrades to `fallbackValue` with `usedFallbackValue: true` on the completion. */
// @see #368
export interface StructuredOutputConfig<T> {
  schema: z.ZodType<T>;
  fallbackValue: T;
  jsonPromptInjection?: boolean | 'auto';
  errorStrategy: 'fallback';
}

/* Token usage normalised across providers; absent (unknown) is deliberately distinct from 0. */
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
    /** Why the provider stopped; absent when the provider reported nothing; the stage-3 eval flags `length` so a truncation cannot score as a miss. */
    finishReason?: string;
  }>;
  /** Every completed tool call on this response with its structured result. */
  // @see #16
  toolResults?: Array<{ name: string; result: unknown; args?: Record<string, unknown> }>;
  /** Token usage for the turn; absent when the provider reported nothing. */
  // @see #224
  usage?: TokenUsage;
  /** Schema-validated structured output when the call requested `structuredOutput`; a validation failure resolves with the configured `fallbackValue` instead of throwing. */
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
  /** Emitted when a tool finishes executing, carrying its structured result. */
  toolResult?: { name: string; result: unknown };
  /** Emitted once after the stream drains, carrying the turn's token usage. */
  // @see #224
  usage?: TokenUsage;
}

export type NeutralChunkStream = AsyncIterable<NeutralStreamChunk>;

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  createStreamingCompletion(options: CompletionOptions): Promise<NeutralChunkStream>;
  /** Completion on a tool-free agent regardless of environment, for aux callers whose target model rejects tool-carrying requests. */
  // @see #41
  createToolFreeCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  /** Overload: with a `structuredOutput` config the completion carries the validated, typed object (the `fallbackValue` on validation failure). */
  // @see #368
  createToolFreeCompletion<T>(
    options: CompletionOptions & { structuredOutput: StructuredOutputConfig<T> },
  ): Promise<NeutralCompletion & { object: T }>;
}
