import Groq from 'groq-sdk';

const getGroqClient = () => {
  return new Groq({
    apiKey: process.env.GROQ_API_KEY || 'dummy_key',
  });
};

export interface RouterConfig {
  smallModel: string;
  largeModel: string;
  guardModel: string;
}

export interface RoutingResult {
  model: string;
  reason: string;
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
    return { model: smallModel, reason: 'deterministic-short' };
  }

  // Rule 2: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    return { model: largeModel, reason: 'deterministic-code' };
  }

  // Tier 2: Guard model classification
  try {
    const groq = getGroqClient();
    const response = await groq.chat.completions.create({
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
      return { model: largeModel, reason: 'classifier-complex' };
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety
    return { model: largeModel, reason: 'classifier-error' };
  }

  return { model: smallModel, reason: 'classifier-simple' };
};
