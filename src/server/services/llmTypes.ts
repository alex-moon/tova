/*
 * Provider-neutral LLM result types shared by every `inferenceService`
 * consumer. Deliberately narrow: only the fields actually read by callers
 * are modelled, so provider-specific shapes (Groq/DeepInfra) cannot leak
 * into call sites. Normalisation from provider shapes happens inside the
 * central service only.
 */

/*
 * Provider toggle carried on options; un-tagged callers default to `groq`
 * (see `inferenceService`). DeepInfra callers get tagged during routing
 * work in #4.
 */
export type LlmProvider = 'groq' | 'deepinfra';

/*
 * LangSmith tracing context (issue #5): optional, attachable per call.
 * `sessionId` groups traces per chat session in LangSmith, `tags` surface
 * routing facts (`model:*` / `reason:*`), `metadata` carries identifiers
 * only — never user content or PII. Empty/plaintext when the exporter is
 * not configured: the fields are simply not exported anywhere.
 */
export interface TraceContext {
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CompletionOptions {
  provider?: LlmProvider;
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  max_tokens?: number;
  /*
   * Client-disconnect signal (wired by `routes/chat.ts` from `req.on('close')`).
   * Optional: only the streaming call site supplies it today.
   */
  abortSignal?: AbortSignal;
  trace?: TraceContext;
}

export interface NeutralCompletion {
  choices: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  /**
   * Web search tool (issue #16): every completed tool call on this response,
   * with the tool's own structured result. `result` is provider-shape-agnostic;
   * the `web_search` tool returns `{ results: { title, snippet, url }[] }`.
   */
  toolResults?: Array<{ name: string; result: unknown }>;
}

export interface NeutralStreamChunk {
  delta?: string | null;
  /** Emitted when the agent decides to call a tool (e.g. `web_search`). */
  toolCall?: {
    name: string;
    /** Structured arguments when the provider surfaces them (issue #33). */
    args?: Record<string, unknown>;
  };
  /** Emitted when a tool finishes executing, carrying its structured result. */
  toolResult?: { name: string; result: unknown };
}

export type NeutralChunkStream = AsyncIterable<NeutralStreamChunk>;

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  createStreamingCompletion(options: CompletionOptions): Promise<NeutralChunkStream>;
}
