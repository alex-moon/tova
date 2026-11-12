import { config } from '../../config';
import { redactForLog } from '../logRedaction';

// System One decision-model endpoint; returns probabilities, not text.
// @see #426

const SYSTEMONE_URL = 'https://api.deepinfra.com/v1/systemone';
const REQUEST_TIMEOUT_MS = 30_000;

export type DecisionQuestionType = 'noul' | 'choice' | 'score';

export interface DecisionQuestion {
  type: DecisionQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer;

export type DecisionAnswers = Record<string, DecisionAnswer>;

export const isNoulAnswer = (answer: DecisionAnswer | undefined): answer is NoulAnswer =>
  answer?.type === 'noul' && typeof answer.noul === 'number';

export const isChoiceAnswer = (answer: DecisionAnswer | undefined): answer is ChoiceAnswer =>
  answer?.type === 'choice' && typeof answer.choice === 'string';

// One decision call: null on missing key, transport error, or non-2xx; caller falls back.
export const systemOneDecide = async (
  label: string,
  state: string,
  questions: Record<string, DecisionQuestion>,
): Promise<DecisionAnswers | null> => {
  const apiKey = config.providers.deepinfraApiKey;
  if (!apiKey) return null;
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.decision.model, state, questions }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('%s: decision endpoint returned %d — falling back', label, res.status);
      return null;
    }
    const data = (await res.json()) as { answers?: DecisionAnswers };
    return data.answers ?? null;
  } catch (err) {
    console.error('%s error:', label, redactForLog(err));
    return null;
  }
};
