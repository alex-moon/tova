import { inferenceService } from './inferenceService';
import { LlmProvider } from './llmTypes';

export interface RouterConfig {
  smallModel: string;
  largeModel: string;
  guardModel: string;
}

export interface RoutingResult {
  model: string;
  reason: string;
  /*
   * Provider rides beside the model, never inside it (env default model
   * strings contain slashes — Mastra's router parses ids on the first slash
   * only). Until DB-pool routing lands (#4 task 7), the env path always
   * resolves to the Groq defaults, so this is the constant `'groq'`.
   */
  provider: LlmProvider;
}

const DEFAULT_CONFIG: RouterConfig = {
  smallModel: process.env.ROUTER_SMALL_MODEL || 'openai/gpt-oss-20b',
  largeModel: process.env.ROUTER_LARGE_MODEL || 'openai/gpt-oss-120b',
  guardModel: process.env.ROUTER_GUARD_MODEL || 'allam-2-7b',
};

export const routeQuery = async (
  query: string,
  config: RouterConfig = DEFAULT_CONFIG,
): Promise<RoutingResult> => {
  const { smallModel, largeModel, guardModel } = config;
  // Tier 1: Deterministic Rules

  // Rule 1: Short queries (greetings, simple confirmations)
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|thanks|thank you)/i.test(query)) {
    return { model: smallModel, reason: 'deterministic-short', provider: 'groq' };
  }

  // Rule 2: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    return { model: largeModel, reason: 'deterministic-code', provider: 'groq' };
  }

  // Tier 2: Guard model classification
  try {
    const response = await inferenceService.createCompletion({
      model: guardModel,
      messages: [
        {
          role: 'user',
          content: `Classify the following user query into "simple" or "complex". Reply with only one word.\n\nQuery: ${query}`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const classification = response.choices[0]?.message?.content?.trim().toLowerCase();

    if (classification === 'complex') {
      return { model: largeModel, reason: 'classifier-complex', provider: 'groq' };
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety
    return { model: largeModel, reason: 'classifier-error', provider: 'groq' };
  }

  return { model: smallModel, reason: 'classifier-simple', provider: 'groq' };
};
