import { redactForLog } from './logRedaction';
import { inferenceService } from './inferenceService';
import { config } from '../config';
import { z } from 'zod';

// Aux model source, read lazily so tests mutating the env after import still see it.
// @see #238
const titleModel = (): string => config.aux.model;

const TITLE_PROMPT =
  'Generate a short chat title (at most six words) summarising what the user asks about.';

// Schema-enforced title; a validation failure resolves with the heuristic fallback computed below.
// @see #368
const TITLE_SCHEMA = z.object({ title: z.string() });

export const generateChatTitle = async (content: string): Promise<string> => {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  const fallback = `${trimmed.substring(0, 30)}${trimmed.length > 30 ? '…' : ''}`;
  try {
    const completion = await inferenceService.createStructuredCompletion({
      provider: config.aux.provider,
      model: titleModel(),
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.3,
      // Reasoning models spend hidden reasoning tokens from this budget before any title text.
      // @see #4
      max_tokens: 512,
      structuredOutput: {
        schema: TITLE_SCHEMA,
        fallbackValue: { title: fallback },
        jsonPromptInjection: 'auto',
        errorStrategy: 'fallback',
      },
    });
    const title = (completion.object.title ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
    if (!title) return fallback;
    return title.length > 60 ? `${title.substring(0, 60)}…` : title;
  } catch (err) {
    console.error('Title generation error:', redactForLog(err));
    return fallback;
  }
};
