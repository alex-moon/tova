import { inferenceService } from './inferenceService';

const SUGGESTION_MODEL = process.env.ROUTER_GUARD_MODEL || 'allam-2-7b';

const SUGGESTION_PROMPT =
  'Generate 2-3 very short follow-up questions the user might ask next, as a ' +
  'natural continuation of the conversation below. Reply with ONLY a JSON ' +
  'array of strings (max five words each), nothing else.';

const MAX_SUGGESTIONS = 3;

export const generateFollowups = async (
  userContent: string,
  assistantContent: string,
): Promise<string[]> => {
  const trimmed = `${userContent}\n\nAssistant replied:\n${assistantContent}`
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 1000);
  try {
    const completion = await inferenceService.createCompletion({
      model: SUGGESTION_MODEL,
      messages: [
        { role: 'system', content: SUGGESTION_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.5,
      max_tokens: 512,
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    const start = raw.indexOf('[');
    const end = raw.indexOf(']', start);
    if (start === -1 || end === -1) return [];
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, MAX_SUGGESTIONS);
  } catch (err) {
    console.error('Followup generation error:', err);
    return [];
  }
};
