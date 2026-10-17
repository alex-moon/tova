import { redactForLog } from './logRedaction';
import { inferenceService } from './inferenceService';
import { config } from '../config';
import { z } from 'zod';

// Aux model source, read lazily.
// @see #238
const suggestionModel = (): string => config.aux.model;

const SUGGESTION_PROMPT =
  'Generate 2-3 very short follow-up questions the user might ask next, as a ' +
  'natural continuation of the conversation below. Max five words each.';

const MAX_SUGGESTIONS = 3;

// Schema-enforced suggestions; a validation failure resolves with an empty list, the same shape as a parse failure.
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
  try {
    // Tool-free path: the suggestion model rejects tool-carrying requests, so this call goes to a plain agent even when the Brave key is set; sessionId threads the run under the chat's trace thread.
    // @see #41 #308
    const completion = await inferenceService.createStructuredCompletion({
      provider: config.aux.provider,
      model: suggestionModel(),
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
    });
    return parseSuggestions(completion.object.suggestions);
  } catch (err) {
    console.error('Followup generation error:', redactForLog(err));
    return [];
  }
};

/* Shared item normalisation: trim, strip wrapping quotes, keep phraselike strings, drop duplicates, cap the list — model-supplied strings still need it. */
// @see #41
export const parseSuggestions = (items: unknown[]): string[] =>
  Array.from(
    new Set(
      items
        .filter((s): s is string => typeof s === 'string')
        .map((s) =>
          s
            .trim()
            .replace(/^["'`]+|["'`]+$/g, '')
            .trim(),
        )
        .filter((s) => s.length > 0 && s.length <= 60),
    ),
  ).slice(0, MAX_SUGGESTIONS);
