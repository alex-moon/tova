import { inferenceService } from './inferenceService';

const TITLE_MODEL = process.env.ROUTER_SMALL_MODEL || 'openai/gpt-oss-20b';

const TITLE_PROMPT =
  'Generate a short chat title (at most six words) summarising what the user asks about. ' +
  'Reply with only the title, no quotes, punctuation, or prefix.';

export const generateChatTitle = async (content: string): Promise<string> => {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  const fallback = `${trimmed.substring(0, 30)}${trimmed.length > 30 ? '…' : ''}`;
  try {
    const completion = await inferenceService.createToolFreeCompletion({
      provider: 'groq',
      model: TITLE_MODEL,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.3,
      // Reasoning models (e.g. `openai/gpt-oss-20b`) spend hidden reasoning
      // tokens from this budget before any title text; 30 was exhausted for
      // every call in live smoke (#4 task 6b). The title text itself only
      // needs ~20 tokens; the rest must absorb the reasoning phase.
      max_tokens: 512,
    });
    const title = completion.choices[0]?.message?.content?.trim().replace(/^["'“”]+|["'“”]+$/g, '');
    if (!title) return fallback;
    return title.length > 60 ? `${title.substring(0, 60)}…` : title;
  } catch (err) {
    console.error('Title generation error:', err);
    return fallback;
  }
};
