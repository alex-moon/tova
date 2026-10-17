import { redactForLog } from './logRedaction';
import { inferenceService } from './inferenceService';
import { config } from '../config';
import { z } from 'zod';

// The subtitle is a soft, revisable scope signal, so the aux model is low-stakes here.
// @see #359
const subtitleModel = (): string => config.aux.model;

const SUBTITLE_PROMPT =
  'You maintain the one-line summary of what a chat is about. You are given ' +
  'the current summary and the latest turns of the chat. Return the updated ' +
  'summary: at most ten words. If the current summary is still accurate, ' +
  'repeat it unchanged.';

// Schema-enforced subtitle; a validation failure resolves with the current subtitle, the same keep-what-is-there degradation.
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
  try {
    const completion = await inferenceService.createStructuredCompletion({
      provider: config.aux.provider,
      model: subtitleModel(),
      messages: [
        { role: 'system', content: SUBTITLE_PROMPT },
        {
          role: 'user',
          content: `Current summary: ${current ? `"${current}"` : '(none yet)'}\n\nLatest turns:\n${recent}`,
        },
      ],
      temperature: 0.3,
      // Reasoning models spend hidden reasoning tokens from this budget before any subtitle text.
      max_tokens: 512,
      structuredOutput: {
        schema: SUBTITLE_SCHEMA,
        fallbackValue: { subtitle: current ?? '' },
        jsonPromptInjection: 'auto',
        errorStrategy: 'fallback',
      },
    });
    const subtitle = (completion.object.subtitle ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
    // A failed/empty revision keeps the current subtitle; the next cadence turn retries.
    if (!subtitle) return current;
    return subtitle.length > MAX_SUBTITLE_LENGTH
      ? `${subtitle.slice(0, MAX_SUBTITLE_LENGTH)}…`
      : subtitle;
  } catch (err) {
    console.error('Subtitle revision error:', redactForLog(err));
    return current;
  }
};
