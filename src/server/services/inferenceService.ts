import Groq from 'groq-sdk';

/*
 * Delegating LLM service: every completion call across the app goes through
 * here so the provider can be swapped in one place. Today only the default
 * `groq` connector exists; DeepInfra (and any other provider) is tracked in
 * #4 and will plug in as an additional connector behind the same interface.
 */
export interface CompletionOptions {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  max_tokens?: number;
}

export interface LlmConnector {
  createCompletion(options: CompletionOptions): Promise<Groq.Chat.ChatCompletion>;
  createStreamingCompletion(
    options: CompletionOptions,
  ): Promise<AsyncIterable<Groq.Chat.ChatCompletionChunk>>;
}

const groqConnector = (): LlmConnector => {
  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY || 'dummy_key',
  });
  return {
    createCompletion: async (options) =>
      client.chat.completions.create({ ...options, stream: false }),
    createStreamingCompletion: async (options) =>
      client.chat.completions.create({ ...options, stream: true }),
  };
};

const connector = groqConnector();

export const inferenceService = {
  createCompletion: (options: CompletionOptions) => connector.createCompletion(options),
  createStreamingCompletion: (options: CompletionOptions) =>
    connector.createStreamingCompletion(options),
};
