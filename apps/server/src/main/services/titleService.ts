import { auxCompletion, stripSurroundingQuotes } from './auxCompletion';
import { z } from 'zod';

const TITLE_PROMPT =
  'Generate a short chat title (at most six words) summarising what the user asks about.';

// Validation failure resolves with the heuristic fallback.
// @see #368
const TITLE_SCHEMA = z.object({ title: z.string() });

export const generateChatTitle = async (content: string): Promise<string> => {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  const fallback = `${trimmed.substring(0, 30)}${trimmed.length > 30 ? '…' : ''}`;
  const completion = await auxCompletion<z.infer<typeof TITLE_SCHEMA>>('Title generation', {
    messages: [
      { role: 'system', content: TITLE_PROMPT },
      { role: 'user', content: trimmed },
    ],
    temperature: 0.3,
    // Reasoning tokens come out of this budget before title text.
    // @see #4
    max_tokens: 512,
    structuredOutput: {
      schema: TITLE_SCHEMA,
      fallbackValue: { title: fallback },
      jsonPromptInjection: 'auto',
      errorStrategy: 'fallback',
    },
  });
  if (!completion) return fallback;
  const title = stripSurroundingQuotes((completion.object.title ?? '').trim());
  if (!title) return fallback;
  return title.length > 60 ? `${title.substring(0, 60)}…` : title;
};
