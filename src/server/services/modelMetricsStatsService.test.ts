import { ModelMetricStat } from '../models/ModelMetricStat';
import { getFitWeight, recordFeedback } from './modelMetricsStatsService';

describe('modelMetricsStatsService', () => {
  it('is neutral below MIN_SAMPLE and Laplace-smooths above it', async () => {
    const cold = await getFitWeight('short|prose', 'm-small');
    expect(cold).toEqual({ weight: 1, ups: 0, downs: 0 });

    for (let i = 0; i < 12; i++) await recordFeedback('short|prose', 'm-small', 'up');
    for (let i = 0; i < 3; i++) await recordFeedback('short|prose', 'm-small', 'down');

    const { weight, ups, downs } = await getFitWeight('short|prose', 'm-small');
    expect(ups).toBe(12);
    expect(downs).toBe(3);
    expect(weight).toBeCloseTo((12 + 1) / (15 + 2), 6);
  });

  it('corrects counters on a revote without double counting', async () => {
    await recordFeedback('long|code', 'm-large', 'up');
    await recordFeedback('long|code', 'm-large', 'down', 'up');

    const stat = await ModelMetricStat.findOne({ band: 'long|code', modelName: 'm-large' });
    expect(stat?.up).toBe(0);
    expect(stat?.down).toBe(1);
  });

  it('ignores same-value repeats and blank bands', async () => {
    await recordFeedback('long|code', 'm-large', 'up');
    await recordFeedback('long|code', 'm-large', 'up', 'up');
    await recordFeedback('', 'm-large', 'up');

    const stat = await ModelMetricStat.findOne({ band: 'long|code', modelName: 'm-large' });
    expect(stat?.up).toBe(1);
    expect(await ModelMetricStat.countDocuments({ band: '' })).toBe(0);
    expect(await ModelMetricStat.countDocuments()).toBe(1);
  });
});
