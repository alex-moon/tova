import Groq from 'groq-sdk';
import { Message } from '../models/Message';
import { computeDeterministicMetrics } from './promptMetrics';

const getGroqClient = () => {
  return new Groq({
    apiKey: process.env.GROQ_API_KEY || 'dummy_key',
  });
};

const LLM_MODEL = process.env.ROUTER_GUARD_MODEL || 'allam-2-7b';

const LLM_PROMPT =
  'Classify the user prompt below. Reply with ONLY one JSON object and nothing else, ' +
  'with exactly these keys: {"emotional": true|false, "technical": true|false, ' +
  '"abstract": true|false, "sentiment": "positive"|"negative"|"neutral", "openEnded": true|false}. ' +
  '"emotional": the prompt is about feelings or personal life rather than a task. ' +
  '"technical": the prompt uses engineering or domain jargon. ' +
  '"abstract": the prompt is strategic/high-level rather than a concrete step-by-step task. ' +
  '"sentiment": the overall tone of the prompt. ' +
  '"openEnded": true if it invites an open discussion, false if it is a one-shot task.';

export interface LlmMetrics {
  emotional: boolean | null;
  technical: boolean | null;
  abstract: boolean | null;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  openEnded: boolean | null;
}

const NULL_LLM: LlmMetrics = {
  emotional: null,
  technical: null,
  abstract: null,
  sentiment: null,
  openEnded: null,
};

const SENTIMENTS = new Set(['positive', 'negative', 'neutral']);

const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

// Extract the first JSON-looking object from raw model output, tolerating
// markdown fences and surrounding prose. Returns null on any failure.
export const parseLlmFlags = (raw: string | null | undefined): LlmMetrics => {
  if (!raw) return NULL_LLM;
  const text = raw.replace(/```[a-z]*/gi, '');
  let start = text.indexOf('{');
  while (start !== -1) {
    // Extend from this '{' to successive '}' until a chunk parses; this
    // recovers output where the object sits between prose or trailing text.
    for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const parsed = {
            emotional: asBoolean(obj.emotional),
            technical: asBoolean(obj.technical),
            abstract: asBoolean(obj.abstract),
            sentiment:
              typeof obj.sentiment === 'string' && SENTIMENTS.has(obj.sentiment)
                ? (obj.sentiment as LlmMetrics['sentiment'])
                : null,
            openEnded: asBoolean(obj.openEnded),
          };
          // A *different* JSON object (prose example, deduped content) may
          // parse before the real flags; a decoy carries none of the
          // expected keys. Restart scanning after it so a decoy followed by
          // the real flags is not misread as all-nulls.
          if (
            parsed.emotional === null &&
            parsed.technical === null &&
            parsed.abstract === null &&
            parsed.sentiment === null &&
            parsed.openEnded === null
          ) {
            break;
          }
          return parsed;
        }
      } catch {
        // keep extending
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return NULL_LLM;
};

export const classifyPromptDimensions = async (content: string): Promise<LlmMetrics> => {
  try {
    const groq = getGroqClient();
    const completion = await groq.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: `${LLM_PROMPT}\n\nPrompt: ${content.trim()}` }],
      temperature: 0,
      max_tokens: 100,
    });
    return parseLlmFlags(completion?.choices?.[0]?.message?.content);
  } catch (err) {
    console.error('Prompt classification error:', err);
    return NULL_LLM;
  }
};

// Classify a user message and persist the flags into its metrics subdocument.
// Never throws for classification problems; only a failed DB update rejects,
// and callers keep that non-fatal for the chat request.
export const classifyAndPersistPromptDimensions = async (
  messageId: string,
  content: string,
): Promise<void> => {
  const llm = await classifyPromptDimensions(content);
  await Message.findByIdAndUpdate(messageId, { $set: { 'metrics.llm': llm } });
};

/*
 * Trivial-prompt skip gate (plan task 9): prompts that are, with confidence,
 * meaningfully neutral on every LLM dimension — short greetings,
 * confirmations, "please continue"-style continuations — skip the
 * classification call entirely. Not a bare regex/allowlist: a phrase list
 * alone misses "yeah sure" — a neutral-token rule covers those — and both
 * paths are bounded (word count, no question mark, no code) and fail
 * closed: anything the heuristic is unsure about still gets classified.
 */
const TRIVIAL_MAX_WORDS = 6;
const TRIVIAL_TOKEN_ONLY_MAX_WORDS = 3;

// Full-message phrases (after lower-casing and punctuation stripping) that
// are neutral on all five flags with essentially no information content.
const TRIVIAL_PHRASES = new Set([
  'yes',
  'no',
  'ok',
  'okay',
  'ok thanks',
  'ok thank you',
  'thank you',
  'thanks',
  'thank you so much',
  'thanks so much',
  'yeah',
  'yep',
  'nope',
  'sure',
  'sure thing',
  'sounds good',
  'sounds great',
  'great',
  'nice',
  'perfect',
  'awesome',
  'cool',
  'got it',
  'gotcha',
  'understood',
  'continue',
  'please continue',
  'go on',
  'go ahead',
  'keep going',
  'tell me more',
  'do it',
  'do that',
  'do so',
  'that works',
  'that sounds good',
  'sounds great to me',
]);

// Tokens that can only appear in a bare confirmation/continuation. Any word
// outside this set makes the prompt fail closed (i.e. get classified).
const TRIVIAL_TOKENS = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'no',
  'nope',
  'ok',
  'okay',
  'sure',
  'fine',
  'cool',
  'great',
  'good',
  'nice',
  'perfect',
  'awesome',
  'thanks',
  'thank',
  'you',
  'please',
  'continue',
  'go',
  'on',
  'ahead',
  'keep',
  'tell',
  'me',
  'more',
  'got',
  'it',
  'i',
  'see',
  'sounds',
  'that',
  'so',
  'do',
  'and',
  'the',
  'my',
  'a',
  'is',
  'right',
  'roger',
  'will',
  'works',
  'understood',
]);

const normalizeForTrivialMatch = (text: string): string =>
  (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// True only when the heuristic is confident; unconfident input returns false
// (fail closed) so it still gets classified.
export const isTriviallyNeutral = (content: string): boolean => {
  const metrics = computeDeterministicMetrics(content);
  if (metrics.hasQuestionMark) return false;
  const { codeIndicators } = metrics;
  if (
    codeIndicators.fences > 0 ||
    codeIndicators.backticks > 0 ||
    codeIndicators.codeTokenCount > 0
  )
    return false;
  if (metrics.wordCount === 0 || metrics.wordCount > TRIVIAL_MAX_WORDS) return false;

  const normalized = normalizeForTrivialMatch(content);
  if (TRIVIAL_PHRASES.has(normalized)) return true;

  // Generic short-confirmation rule: a very short prompt made entirely of
  // neutral tokens ("yeah sure", "ok thanks", "tell me more").
  if (metrics.wordCount <= TRIVIAL_TOKEN_ONLY_MAX_WORDS) {
    const words = normalized.split(' ');
    if (words.length > 0 && words.every((w) => TRIVIAL_TOKENS.has(w))) return true;
  }
  return false;
};
