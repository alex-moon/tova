import type {
  DecisionAnswers,
  DecisionAnswer,
  DecisionQuestion,
} from '../main/services/llm/systemOneClient';

// Inert System One stub: every suite gets a null-decision default, so no test
// reaches the live endpoint. Suites testing the decision seam jest.mock it.
// @see #426

export const systemOneDecide = async (
  _label: string,
  _state: string,
  _questions: Record<string, DecisionQuestion>,
): Promise<DecisionAnswers | null> => null;

export const isNoulAnswer = (
  answer: DecisionAnswer | undefined,
): answer is DecisionAnswer & { type: 'noul'; noul: number } =>
  answer?.type === 'noul' && typeof answer.noul === 'number';

export const isChoiceAnswer = (
  answer: DecisionAnswer | undefined,
): answer is DecisionAnswer & { type: 'choice'; choice: string } =>
  answer?.type === 'choice' && typeof answer.choice === 'string';
