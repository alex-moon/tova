import { redactForLog } from './logRedaction';
import { inferenceService } from './inferenceService';
import { config } from '../config';

// Aux model source, read lazily.
// @see #238
const suggestionModel = (): string => config.aux.model;

const SUGGESTION_PROMPT =
  'Generate 2-3 very short follow-up questions the user might ask next, as a ' +
  'natural continuation of the conversation below. Reply with ONLY a JSON ' +
  'array of strings (max five words each), nothing else.';

const MAX_SUGGESTIONS = 3;

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
    const completion = await inferenceService.createToolFreeCompletion({
      provider: config.aux.provider,
      model: suggestionModel(),
      messages: [
        { role: 'system', content: SUGGESTION_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.5,
      max_tokens: 512,
      ...(sessionId ? { trace: { sessionId } } : {}),
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    return parseSuggestions(raw);
  } catch (err) {
    console.error('Followup generation error:', redactForLog(err));
    return [];
  }
};

/* Tolerant parser: the suggestion model intermittently wraps a usable list in prose; strategies salvage in order and total failure degrades to []. */
// @see #41
export const parseSuggestions = (raw: string): string[] => {
  // 1. Clean JSON array. 2. The pre-#41 bracket slice. 3. Any `[`..`]` span (prose-wrapped arrays).
  // @see #41
  for (const candidate of [raw, ...bracketSpans(raw)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!Array.isArray(parsed)) continue;
      const items = parseList(parsed);
      if (items.length > 0) return items;
    } catch {
      // Not this one — try the next candidate.
    }
  }
  // 4. Fall back to reading the raw response as a plain list; requires at least two survivors (a single line is indistinguishable from prose).
  const fromLines = parseList(
    raw
      .split(/['"`\n;,]|\s\d+[.)]\s*|\s-\s/m)
      .map((part) =>
        part
          .trim()
          .replace(/^[*•\-\s]+/, '')
          .replace(/^\d+[.)]\s*/, '')
          .replace(/^["'`[\]{}().]+|["'`[\]{}(),]+$/g, '')
          .trim(),
      )
      .filter((part) => part.length > 0),
  );
  return fromLines.length >= 2 ? fromLines : [];
};

/* Every `[` to matching-`]` span, longest first; nested arrays covered naturally (the outermost span parses, inner ones don't). */
const bracketSpans = (text: string): string[] => {
  const spans: string[] = [];
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    for (let end = text.indexOf(']', start + 1); end !== -1; end = text.indexOf(']', end + 1)) {
      spans.push(text.slice(start, end + 1));
    }
  }
  return spans.sort((a, b) => b.length - a.length);
};

/* Shared array-item normalisation: trim, strip wrapping quotes, keep phraselike strings, drop duplicates, cap the list. */
const parseList = (items: unknown[]): string[] =>
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
