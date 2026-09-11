/*
 * Provider-neutral LLM result types shared by every `inferenceService`
 * consumer. Deliberately narrow: only the fields actually read by callers
 * are modelled, so provider-specific shapes (Groq/DeepInfra) cannot leak
 * into call sites. Normalisation from provider shapes happens inside the
 * central service only.
 */

export interface CompletionOptions {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  max_tokens?: number;
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
