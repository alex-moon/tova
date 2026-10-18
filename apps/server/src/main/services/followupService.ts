import { auxCompletion, stripSurroundingQuotes } from './auxCompletion';
import { z } from 'zod';

const SUGGESTION_PROMPT =
  'Generate 2-3 very short follow-up questions the user might ask next, as a ' +
  'natural continuation of the conversation below. Max five words each.';

const MAX_SUGGESTIONS = 3;

// Schema-enforced suggestions; validation failure falls back to empty.
// @see #368
const SUGGESTIONS_SCHEMA = z.object({ suggestions: z.array(z.string()) });

export const generateFollowups = async (
  userContent: string,
  assistantContent: string,
  sessionId?: string,
): Promise<string[]> => {
  const trimmed = `${userContent}\n\nAssistant replied:\n${assistantContent}`
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 1000);
  // Tool-free path: the suggestion model rejects tool-carrying requests.
  // @see #41 #308
  const completion = await auxCompletion<z.infer<typeof SUGGESTIONS_SCHEMA>>(
    'Followup generation',
    {
      messages: [
        { role: 'system', content: SUGGESTION_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.5,
      max_tokens: 512,
      ...(sessionId ? { trace: { sessionId } } : {}),
      structuredOutput: {
        schema: SUGGESTIONS_SCHEMA,
        fallbackValue: { suggestions: [] },
        jsonPromptInjection: 'auto',
        errorStrategy: 'fallback',
      },
    },
  );
  if (!completion) return [];
  return parseSuggestions(completion.object.suggestions);
};

/* Shared normalisation: trim, strip quotes, dedupe, cap the list. */
// @see #41
export const parseSuggestions = (items: unknown[]): string[] =>
  Array.from(
    new Set(
      items
        .filter((s): s is string => typeof s === 'string')
        .map((s) => stripSurroundingQuotes(s.trim()).trim())
        .filter((s) => s.length > 0 && s.length <= 60),
    ),
  ).slice(0, MAX_SUGGESTIONS);
