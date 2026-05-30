import Groq from 'groq-sdk';

const getGroqClient = () => {
  return new Groq({
    apiKey: process.env.GROQ_API_KEY || 'dummy_key',
  });
};

const SMALL_MODEL = 'llama3-8b-8192';
const LARGE_MODEL = 'llama3-70b-8192';

export interface RoutingResult {
  model: string;
  reason: string;
}

export const routeQuery = async (query: string): Promise<RoutingResult> => {
  // Tier 1: Deterministic Rules

  // Rule 1: Short queries (greetings, simple confirmations)
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|thanks|thank you)/i.test(query)) {
    return { model: SMALL_MODEL, reason: 'deterministic-short' };
  }

  // Rule 2: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    return { model: LARGE_MODEL, reason: 'deterministic-code' };
  }

  // Tier 2: Classifier (Llama-3-8B)
  try {
    const groq = getGroqClient();
    const response = await groq.chat.completions.create({
      model: SMALL_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Classify the following user query into "simple" or "complex". Return only one word.',
        },
        {
          role: 'user',
          content: query,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const classification = response.choices[0]?.message?.content?.trim().toLowerCase();

    if (classification === 'complex') {
      return { model: LARGE_MODEL, reason: 'classifier-complex' };
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety
    return { model: LARGE_MODEL, reason: 'classifier-error' };
  }

  return { model: SMALL_MODEL, reason: 'classifier-simple' };
};
