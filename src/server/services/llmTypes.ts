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
}

export interface NeutralCompletion {
  choices: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export interface NeutralStreamChunk {
  delta?: string | null;
}

export type NeutralChunkStream = AsyncIterable<NeutralStreamChunk>;

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<NeutralCompletion>;
  createStreamingCompletion(options: CompletionOptions): Promise<NeutralChunkStream>;
}
