/**
 * Feedback aggregation for #18: thumbs up/down tallies per
 * (routing band, model name), consumed by the router to weight empirical
 * model-vs-band fit. Counters are corrected on revote so a vote switch never
 * double-counts (plan decision 2).
 */

import { ModelMetricStat } from '../models/ModelMetricStat';

export type FeedbackValue = 'up' | 'down';

export interface FitWeight {
  weight: number;
  ups: number;
  downs: number;
}

// Below this many total tallies in a (band, model) cell the weight is
// neutral: a cold-start cell must not flip routing.
const MIN_SAMPLE = 5;

// Laplace-smoothed so one vote on an empty cell cannot max out.
const fitWeight = (ups: number, downs: number): number => (ups + 1) / (ups + downs + 2);

export const recordFeedback = async (
  band: string,
  modelName: string,
  value: FeedbackValue,
  prevValue?: FeedbackValue | null,
): Promise<void> => {
  if (!band) return;
  if (value === prevValue) return;
  const inc: Record<string, number> = { [value === 'up' ? 'up' : 'down']: 1 };
  if (prevValue) {
    inc[prevValue === 'up' ? 'up' : 'down'] = -1;
  }
  await ModelMetricStat.findOneAndUpdate({ band, modelName }, { $inc: inc }, { upsert: true });
};

// Total: any read error or cold-start cell yields a neutral weight so feedback
// stats can never break routing.
export const getFitWeight = async (band: string, modelName: string): Promise<FitWeight> => {
  try {
    const stat = await ModelMetricStat.findOne({ band, modelName });
    const ups = stat?.up ?? 0;
    const downs = stat?.down ?? 0;
    if (ups + downs < MIN_SAMPLE) {
      return { weight: 1, ups, downs };
    }
    return { weight: fitWeight(ups, downs), ups, downs };
  } catch (err) {
    console.error('Model metrics stats read error:', err);
    return { weight: 1, ups: 0, downs: 0 };
  }
};
