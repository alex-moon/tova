import Groq from 'groq-sdk';
import { Message } from '../models/Message';

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
  const start = text.indexOf('{');
  if (start === -1) return NULL_LLM;
  // Extend from the first '{' to successive '}' until a chunk parses; this
  // recovers output where the object sits between prose or trailing text.
  for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return {
          emotional: asBoolean(obj.emotional),
          technical: asBoolean(obj.technical),
          abstract: asBoolean(obj.abstract),
          sentiment:
            typeof obj.sentiment === 'string' && SENTIMENTS.has(obj.sentiment)
              ? (obj.sentiment as LlmMetrics['sentiment'])
              : null,
          openEnded: asBoolean(obj.openEnded),
        };
      }
    } catch {
      // keep extending
    }
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
