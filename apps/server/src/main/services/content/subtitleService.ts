import { auxCompletion, stripSurroundingQuotes } from '../llm/auxCompletion';
import { z } from 'zod';

const SUBTITLE_PROMPT =
  'You maintain the one-line summary of what a chat is about. You are given ' +
  'the current summary and the latest turns of the chat. Return the updated ' +
  'summary: at most ten words. If the current summary is still accurate, ' +
  'repeat it unchanged.';

// Validation failure resolves with the current subtitle.
// @see #368
const SUBTITLE_SCHEMA = z.object({ subtitle: z.string() });

export interface SubtitleTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_SUBTITLE_LENGTH = 80;
const TURN_CHAR_CAP = 400;

export const reviseSessionSubtitle = async (
  current: string | null,
  turns: SubtitleTurn[],
): Promise<string | null> => {
  const recent = turns
    .slice(-3)
    .map((t) => `${t.role}: ${(t.content ?? '').replace(/\s+/g, ' ').slice(0, TURN_CHAR_CAP)}`)
    .join('\n');
  const completion = await auxCompletion<z.infer<typeof SUBTITLE_SCHEMA>>('Subtitle revision', {
    messages: [
      { role: 'system', content: SUBTITLE_PROMPT },
      {
        role: 'user',
        content: `Current summary: ${current ? `"${current}"` : '(none yet)'}\n\nLatest turns:\n${recent}`,
      },
    ],
    temperature: 0.3,
    // Reasoning tokens come out of this budget before subtitle text.
    max_tokens: 512,
    structuredOutput: {
      schema: SUBTITLE_SCHEMA,
      fallbackValue: { subtitle: current ?? '' },
      jsonPromptInjection: 'auto',
      errorStrategy: 'fallback',
    },
  });
  if (!completion) return current;
  const subtitle = stripSurroundingQuotes((completion.object.subtitle ?? '').trim());
  // A failed/empty revision keeps the current subtitle.
  if (!subtitle) return current;
  return subtitle.length > MAX_SUBTITLE_LENGTH
    ? `${subtitle.slice(0, MAX_SUBTITLE_LENGTH)}…`
    : subtitle;
};
