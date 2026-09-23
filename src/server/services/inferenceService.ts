import { CompletionOptions, LlmConnector, LlmProvider } from './llmTypes';
import { deepinfraConnector, groqConnector } from './mastraService';

/*
 * Delegating LLM service: every completion call across the app goes through
 * here so the provider can be swapped in one place. Callers may target a
 * provider explicitly via `options.provider`; un-tagged callers stay on
 * `groq` today so existing call sites (guard classifier, title, metrics)
 * are unaffected, and #151 flips that default to `typesafe`. The registry
 * stays Partial so a new provider can land in the plumbing before its
 * connector does (#151) — resolution surfaces the unknown-provider error
 * below instead of breaking the type contract mid-migration.
 */
export { CompletionOptions, NeutralCompletion, NeutralChunkStream } from './llmTypes';
export type { LlmConnector, LlmProvider } from './llmTypes';

const connectors: Partial<Record<LlmProvider, LlmConnector>> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  // typesafe connector lands with #151's openai-compatible wiring.
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
