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

/*
 * Providers are typed on `CompletionOptions`, but model refs sourced from
 * MongoDB (`modelConfigService`) are untyped at the boundary — a corrupted
 * or unsupported provider string must not surface as a bare
 * `TypeError: undefined is not a function` mid-request.
 */
const connectorFor = (provider: LlmProvider | undefined): LlmConnector => {
  const connector = connectors[provider ?? 'groq'];
  if (!connector) throw new Error(`Unknown LLM provider: ${String(provider)}`);
  return connector;
};

export const inferenceService = {
  createCompletion: async (options: CompletionOptions) => {
    const connector = connectorFor(options.provider);
    return connector.createCompletion(options);
  },
  createStreamingCompletion: async (options: CompletionOptions) => {
    const connector = connectorFor(options.provider);
    return connector.createStreamingCompletion(options);
  },
  createToolFreeCompletion: async (options: CompletionOptions) => {
    const connector = connectorFor(options.provider);
    return connector.createToolFreeCompletion(options);
  },
};
