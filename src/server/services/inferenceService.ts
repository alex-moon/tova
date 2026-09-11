import { CompletionOptions, LlmConnector, LlmProvider } from './llmTypes';
import { deepinfraConnector, groqConnector } from './mastraService';

/*
 * Delegating LLM service: every completion call across the app goes through
 * here so the provider can be swapped in one place. Callers may target a
 * provider explicitly via `options.provider`; un-tagged callers stay on
 * `groq` so existing call sites (guard classifier, title, metrics) are
 * unaffected. All transport lives behind the connectors in
 * `mastraService.ts` (the single owner of `@mastra/*` imports); provider
 * shapes are normalised to the neutral types there.
 */
export { CompletionOptions, NeutralCompletion, NeutralChunkStream } from './llmTypes';
export type { LlmConnector, LlmProvider } from './llmTypes';

const connectors: Record<LlmProvider, LlmConnector> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
};

export const inferenceService = {
  createCompletion: async (options: CompletionOptions) => {
    const connector = connectors[options.provider ?? 'groq'];
    return connector.createCompletion(options);
  },
  createStreamingCompletion: async (options: CompletionOptions) => {
    const connector = connectors[options.provider ?? 'groq'];
    return connector.createStreamingCompletion(options);
  },
};
