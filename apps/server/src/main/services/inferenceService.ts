import {
  CompletionOptions,
  LlmConnector,
  LlmProvider,
  NeutralCompletion,
  StructuredOutputConfig,
} from './llmTypes';
import { deepinfraConnector, fireworksConnector, groqConnector } from './mastraService';
import { recordModelError } from './modelErrorTally';

/* Delegating LLM service: provider swaps happen in one place. */
// @see #151
export {
  CompletionOptions,
  NeutralCompletion,
  NeutralChunkStream,
  StructuredOutputConfig,
} from './llmTypes';
export type { LlmConnector, LlmProvider } from './llmTypes';

const connectors: Partial<Record<LlmProvider, LlmConnector>> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
};

/* The one wired-provider registry; compare/evals read it, not their own maps.
 * @see #398
 */
export const wiredProviders: readonly LlmProvider[] = Object.keys(connectors) as LlmProvider[];

// Untyped provider strings (Mongo, HTTP) must not TypeError.
export const isWiredProvider = (value: unknown): value is LlmProvider =>
  typeof value === 'string' && value in connectors;

// Record failures against the provider route before rethrowing.
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

/* Provider strings from Mongo are untyped; a bad value must not TypeError. */
const connectorFor = (provider: LlmProvider | undefined): LlmConnector => {
  const connector = connectors[provider ?? 'groq'];
  if (!connector) throw new Error(`Unknown LLM provider: ${String(provider)}`);
  return connector;
};

export const inferenceService = {
  createCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createCompletion(options)),
  createStreamingCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createStreamingCompletion(options)),
  createToolFreeCompletion: async (options: CompletionOptions) =>
    withTally(options, (connector) => connector.createToolFreeCompletion(options)),
  /** Typed passthrough: structuredOutput pins the object type. */
  // @see #368
  createStructuredCompletion: async <T>(
    options: CompletionOptions & { structuredOutput: StructuredOutputConfig<T> },
  ): Promise<NeutralCompletion & { object: T }> =>
    // Typed result asserted once; the overload wins resolution.
    // @see #368
    withTally(options, (connector) => connector.createToolFreeCompletion(options)) as Promise<
      NeutralCompletion & { object: T }
    >,
};
