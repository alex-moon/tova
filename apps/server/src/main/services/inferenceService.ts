import { CompletionOptions, LlmConnector, LlmProvider } from './llmTypes';
import { deepinfraConnector, fireworksConnector, groqConnector } from './mastraService';
import { recordModelError } from './modelErrorTally';

/* Delegating LLM service: every completion call goes through here so the provider swaps in one place; the registry stays Partial so a provider can land in plumbing before its connector. */
// @see #151
export { CompletionOptions, NeutralCompletion, NeutralChunkStream } from './llmTypes';
export type { LlmConnector, LlmProvider } from './llmTypes';

const connectors: Partial<Record<LlmProvider, LlmConnector>> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
};

/* Provider strings sourced from Mongo are untyped at the boundary; a corrupted value must not surface as a bare TypeError mid-request. */
const connectorFor = (provider: LlmProvider | undefined): LlmConnector => {
  const connector = connectors[provider ?? 'groq'];
  if (!connector) throw new Error(`Unknown LLM provider: ${String(provider)}`);
  return connector;
};

// Record every completion failure against its provider route before rethrowing; this is the single choke point for all LLM calls.
// @see #175
const withTally = async <T>(
  options: CompletionOptions,
  run: (connector: LlmConnector) => Promise<T>,
): Promise<T> => {
  const provider: LlmProvider = options.provider ?? 'groq';
  try {
    return await run(connectorFor(provider));
  } catch (err) {
    recordModelError(provider, options.model, err);
    throw err;
  }
};

export const inferenceService = {
  createCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createCompletion(options)),
  createStreamingCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createStreamingCompletion(options)),
  createToolFreeCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createToolFreeCompletion(options)),
};
