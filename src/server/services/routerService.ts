import { inferenceService } from './inferenceService';
import { getFitWeight, FitWeight } from './modelMetricsStatsService';

export interface RouterConfig {
  smallModel: string;
  largeModel: string;
  guardModel: string;
}

export interface RoutingResult {
  model: string;
  reason: string;
}

// Feedback-weighting injectables (issue #18): getFitWeight returns the
// empirical up/down fit for a (band, model) cell; band is the deterministic
// routing band of the user turn. Tests inject stubs so no Mongo is needed.
export interface RouterDeps {
  band?: string;
  getFitWeight?: (band: string, model: string) => Promise<FitWeight>;
}

const DEFAULT_CONFIG: RouterConfig = {
  smallModel: process.env.ROUTER_SMALL_MODEL || 'openai/gpt-oss-20b',
  largeModel: process.env.ROUTER_LARGE_MODEL || 'openai/gpt-oss-120b',
  guardModel: process.env.ROUTER_GUARD_MODEL || 'allam-2-7b',
};

const defaultGetFitWeight = getFitWeight;

// The feedback-based choice only flips when the empirical evidence is strong
// enough: the challenger's fit weight must beat the classifier's pick by this
// ratio. A constant in v1, not a tunable.
const FEEDBACK_FLIP_RATIO = 1.25;

type FeedbackPath = 'classifier-simple' | 'classifier-complex';

// Applies the empirical fit weight on the classifier tiebreak paths only —
// the deterministic rules and classifier-error stay untouched (plan
// decision 5). Returns the adjusted result, with weight and tallies appended
// to the reason so LangSmith (#5) can surface them.
const applyFeedbackWeight = async (
  winner: 'small' | 'large',
  reason: FeedbackPath,
  config: RouterConfig,
  deps: RouterDeps,
): Promise<RoutingResult> => {
  const { smallModel, largeModel } = config;
  const band = deps.band ?? '';
  const readWeight = deps.getFitWeight ?? defaultGetFitWeight;
  const chosenModel = winner === 'small' ? smallModel : largeModel;
  const rivalModel = winner === 'small' ? largeModel : smallModel;

  const [chosen, rival] = await Promise.all([
    readWeight(band, chosenModel),
    readWeight(band, rivalModel),
  ]);

  const ratio = chosen.weight > 0 && rival.weight > 0 ? rival.weight / chosen.weight : 0;
  const hasData = chosen.ups + chosen.downs + rival.ups + rival.downs > 0;
  if (ratio <= FEEDBACK_FLIP_RATIO) {
    return {
      model: chosenModel,
      reason: hasData
        ? `${reason};feedback-weight:${chosen.weight.toFixed(2)}:${chosen.ups}/${chosen.downs}`
        : reason,
    };
  }
  return {
    model: rivalModel,
    reason: hasData
      ? `${reason};feedback-weight:${rival.weight.toFixed(2)}:${rival.ups}/${rival.downs}`
      : reason,
  };
};

export const routeQuery = async (
  query: string,
  config: RouterConfig = DEFAULT_CONFIG,
  deps: RouterDeps = {},
): Promise<RoutingResult> => {
  const { smallModel, largeModel, guardModel } = config;
  // Tier 1: Deterministic Rules

  // Rule 1: Short queries (greetings, simple confirmations)
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|thanks|thank you)/i.test(query)) {
    return { model: smallModel, reason: 'deterministic-short' };
  }

  // Rule 2: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    return { model: largeModel, reason: 'deterministic-code' };
  }

  // Tier 2: Guard model classification
  try {
    const response = await inferenceService.createCompletion({
      model: guardModel,
      messages: [
        {
          role: 'user',
          content: `Classify the following user query into "simple" or "complex". Reply with only one word.\n\nQuery: ${query}`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const classification = response.choices[0]?.message?.content?.trim().toLowerCase();

    if (classification === 'complex') {
      return await applyFeedbackWeight('large', 'classifier-complex', config, deps);
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety
    return { model: largeModel, reason: 'classifier-error' };
  }

  return await applyFeedbackWeight('small', 'classifier-simple', config, deps);
};
