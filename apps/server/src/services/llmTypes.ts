/*
 * Provider-neutral LLM result types shared by every `inferenceService`
 * consumer. Deliberately narrow: only the fields actually read by callers
 * are modelled, so provider-specific shapes (Groq/DeepInfra) cannot leak
 * into call sites. Normalisation from provider shapes happens inside the
 * central service only.
 */

/*
 * Provider toggle carried on options; un-tagged callers default to `groq`
 * today (see `inferenceService`), but #151 moves the default to `typesafe`:
 * routing/classification/auxiliary work runs on Jev hosted on the TypeSafe
 * API. DeepInfra callers get tagged during routing work in #4.
 */
export type LlmProvider = 'groq' | 'deepinfra' | 'fireworks' | 'typesafe';

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

/*
 * Multimodal message content (#115): OpenAI-style content parts. The image
 * part carries an HTTPS URL the provider fetches (presigned Spaces GET URL
 * from the chat route); text-only callers keep passing plain strings and the
 * union stays invisible to them.
 */
export type MessageContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface CompletionOptions {
  provider?: LlmProvider;
  model: string;
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: string | MessageContentPart[];
  }[];
  /*
   * Calling user id for this turn (set by the chat routes). Rides into
   * Mastra's request context (mastraService's `callOptionsFrom`) so
   * built-in tools can scope their execution per user (#58) without
   * baking user data into memoised agent instances.
   */
  userId?: string;
  /*
   * Calling session id for this turn (issue #252), set by the chat routes.
   * Distinct from `trace.sessionId`: `trace` is a LangSmith-tracing concern
   * and is deliberately absent for ZDR/raced turns, whereas tools that write
   * provenance need the session independently of tracing. Rides into Mastra's
   * request context like `userId`; absent means unknown (never invented).
   */
  sessionId?: string;
  temperature?: number;
  max_tokens?: number;
  /*
   * Client-disconnect signal (wired by `routes/chat.ts` from `req.on('close')`).
   * Optional: only the streaming call site supplies it today.
   */
  abortSignal?: AbortSignal;
  trace?: TraceContext;
}

/*
 * Token usage for a turn (issue #224), normalised across providers. Every
 * field is optional and left **absent** when the provider reported nothing —
 * `undefined` means unknown, deliberately distinct from `0` (mirrors the
 * #199 "unknown price ≠ free" stance). `totalTokens` is the turn's real spend
 * across all tool steps; in/out are the provider's prompt/completion split.
 */
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
  }>;
  /**
   * Web search tool (issue #16): every completed tool call on this response,
   * with the tool's own structured result. `result` is provider-shape-agnostic;
   * the `web_search` tool returns `{ results: { title, snippet, url }[] }`.
   */
  toolResults?: Array<{ name: string; result: unknown }>;
  /**
   * Token usage for the turn (issue #224). Absent when the provider reported
   * nothing; callers persist it for the per-message cost view.
   */
  usage?: TokenUsage;
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
  /**
   * Emitted once, after the stream drains, carrying the turn's token usage
   * (issue #224). Mirrors `NeutralCompletion.usage`; absence means the
   * provider reported nothing.
   */
  usage?: TokenUsage;
}

export type NeutralChunkStream = AsyncIterable<NeutralStreamChunk>;

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  createStreamingCompletion(options: CompletionOptions): Promise<NeutralChunkStream>;
  /**
   * Completion on a tool-free agent regardless of environment (issue #41):
   * for auxiliary callers whose target model rejects tool-carrying requests
   * (follow-up suggestions), so such a call never receives web_search even
   * when the Brave key is set.
   */
  createToolFreeCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
}
