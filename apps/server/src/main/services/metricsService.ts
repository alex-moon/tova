import { auxCompletion, AUX_INPUT_CHAR_CAP } from './llm/auxCompletion';
import { Message } from '../models/Message';
import { computeDeterministicMetrics } from './promptMetrics';
import { z } from 'zod';

const LLM_PROMPT =
  'Classify the user prompt below. ' +
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

// Validation failure resolves with NULL_LLM, the parse-failure shape.
// @see #368
const FLAGS_SCHEMA = z.object({
  emotional: z.boolean(),
  technical: z.boolean(),
  abstract: z.boolean(),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  openEnded: z.boolean(),
});

// Classify a prompt and report why flags could be missing: parse or error.
export const classifyPromptDimensions = async (
  content: string,
  sessionId?: string,
): Promise<{ llm: LlmMetrics; skipReason: 'parse' | 'error' | null }> => {
  // Tool-free agent; sessionId threads the aux run under the chat thread.
  // @see #77 #41 #308
  const completion = await auxCompletion<LlmMetrics>('Prompt classification', {
    messages: [
      {
        role: 'user',
        content: `${LLM_PROMPT}\n\nPrompt: ${content.trim().substring(0, AUX_INPUT_CHAR_CAP)}`,
      },
    ],
    temperature: 0,
    // Reasoning tokens come out of this budget before any flags text.
    // @see #378 #4
    max_tokens: 1024,
    ...(sessionId ? { trace: { sessionId } } : {}),
    structuredOutput: {
      schema: FLAGS_SCHEMA,
      fallbackValue: NULL_LLM,
      jsonPromptInjection: 'auto',
      errorStrategy: 'fallback',
    },
  });
  if (!completion) return { llm: NULL_LLM, skipReason: 'error' };
  const skipReason = isAllNullLlm(completion.object) ? ('parse' as const) : null;
  if (skipReason === 'parse') {
    console.warn(
      'Prompt classification: unparseable classifier output — flags left null; check the aux model token budget.',
    );
  }
  return { llm: completion.object, skipReason };
};

const isAllNullLlm = (llm: LlmMetrics): boolean =>
  llm.emotional === null &&
  llm.technical === null &&
  llm.abstract === null &&
  llm.sentiment === null &&
  llm.openEnded === null;

// Classify and persist flags; never throws; llmSkipReason records why null.
// @see #238
export const classifyAndPersistPromptDimensions = async (
  messageId: string,
  content: string,
  sessionId?: string,
): Promise<void> => {
  const { llm, skipReason } = await classifyPromptDimensions(content, sessionId);
  await Message.findByIdAndUpdate(messageId, {
    $set: { 'metrics.llm': llm, 'metrics.llmSkipReason': skipReason },
  });
};

/* Trivial-prompt skip gate: confident neutral prompts skip classification. */
const TRIVIAL_MAX_WORDS = 6;
const TRIVIAL_TOKEN_ONLY_MAX_WORDS = 3;

// Full-message phrases neutral on all five flags with no information content.
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

// Tokens only in a bare confirmation; any other word fails closed.
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

// True only when confident; unconfident input returns false (fail closed).
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

  // Short-confirmation rule: a very short prompt of all neutral tokens.
  if (metrics.wordCount <= TRIVIAL_TOKEN_ONLY_MAX_WORDS) {
    const words = normalized.split(' ');
    if (words.length > 0 && words.every((w) => TRIVIAL_TOKENS.has(w))) return true;
  }
  return false;
};
