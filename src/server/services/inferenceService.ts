import Groq from 'groq-sdk';
import { CompletionOptions, LlmConnector, NeutralChunkStream, NeutralCompletion } from './llmTypes';

/*
 * Delegating LLM service: every completion call across the app goes through
 * here so the provider can be swapped in one place. Today only the default
 * `groq` connector exists; DeepInfra (and any other provider) is tracked in
 * #4 and will plug in as an additional connector behind the same interface.
 * Provider shapes are normalised to the neutral types from `llmTypes.ts`
 * right here — callers never see Groq types.
 */
export { CompletionOptions, NeutralCompletion, NeutralChunkStream } from './llmTypes';
export type { LlmConnector } from './llmTypes';

const groqConnector = (): LlmConnector => {
  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY || 'dummy_key',
  });

  const toNeutralCompletion = (r: Groq.Chat.ChatCompletion): NeutralCompletion => ({
    choices: (r?.choices ?? []).map((c) => ({
      message: { content: c?.message?.content ?? null },
    })),
  });

  const toNeutralStream = async (
    raw: AsyncIterable<Groq.Chat.ChatCompletionChunk>,
  ): Promise<NeutralChunkStream> =>
    (async function* () {
      for await (const chunk of raw) {
        yield { delta: chunk.choices[0]?.delta?.content ?? null };
      }
    })();

  return {
    createCompletion: async (options) =>
      toNeutralCompletion(await client.chat.completions.create({ ...options, stream: false })),
    createStreamingCompletion: async (options) =>
      toNeutralStream(await client.chat.completions.create({ ...options, stream: true })),
  };
};

const connector = groqConnector();

export const inferenceService = {
  createCompletion: (options: CompletionOptions) => connector.createCompletion(options),
  createStreamingCompletion: (options: CompletionOptions) =>
    connector.createStreamingCompletion(options),
};
