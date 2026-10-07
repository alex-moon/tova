import { EvalRunRecord } from '../models/EvalRunRecord';
import { clampLimit, getEvalRun, listEvalRuns, MAX_LIMIT } from './evalRunsAdminService';

/*
 * #225 read-side coverage for the admin Evals tab: limit clamping, newest-first
 * ordering with per-score counts, the detail projection, and the guard against
 * prototype-chain score names in the counts rollup.
 */

const seed = (startedAt: Date, results: Record<string, unknown>[] = [], over = {}) =>
  EvalRunRecord.create({
    startedAt,
    status: 'done',
    finishedAt: new Date(),
    models: ['deepinfra:openai/gpt-oss-20b'],
    results,
    ...over,
  });

const result = (score: string, caseId = 'a') => ({
  caseId,
  model: 'm',
  provider: 'deepinfra',
  score,
  report: 'r',
});

describe('clampLimit (#225)', () => {
  it('defaults to 30 for a missing/non-integer limit', () => {
    expect(clampLimit(undefined)).toBe(30);
    expect(clampLimit(1.5)).toBe(30);
    expect(clampLimit(Number.NaN)).toBe(30);
  });

  it('clamps into [1, MAX_LIMIT]', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(MAX_LIMIT + 1000)).toBe(MAX_LIMIT);
  });
});

describe('listEvalRuns / getEvalRun (#225)', () => {
  it('returns runs newest first with per-score counts', async () => {
    await seed(new Date('2026-10-01T00:00:00Z'), [result('pass'), result('fail', 'b')]);
    await seed(new Date('2026-10-03T00:00:00Z'), [result('partial'), result('error', 'c')]);

    const runs = await listEvalRuns();
    expect(runs.map((r) => r.startedAt)).toEqual([
      '2026-10-03T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(runs[0].counts).toEqual({ pass: 0, partial: 1, fail: 0, error: 1 });
    expect(runs[0].total).toBe(2);
  });

  it('projects a run detail with its per-case rows', async () => {
    const doc = await seed(new Date('2026-10-02T00:00:00Z'), [
      result('pass', 'case-a'),
      result('fail', 'case-b'),
    ]);
    const detail = await getEvalRun(doc._id.toString());
    expect(detail?.id).toBe(doc._id.toString());
    expect(detail?.results).toHaveLength(2);
    expect(detail?.results[0]).toMatchObject({ caseId: 'case-a', score: 'pass', report: 'r' });
  });

  it('returns null for an unknown id', async () => {
    expect(await getEvalRun('64b7f9f2a1c3d4e5f6a7b8c9')).toBeNull();
  });

  it('counts a prototype-chain score name as an error, not a real key', async () => {
    // "constructor" is `in` a plain object via Object.prototype; the counts
    // rollup must not treat it as a pass/partial/fail/error key.
    const doc = await seed(new Date('2026-10-04T00:00:00Z'), [result('constructor')]);
    const runs = await listEvalRuns();
    expect(runs[0].counts).toEqual({ pass: 0, partial: 0, fail: 0, error: 1 });
    expect(String(runs[0].counts.error)).toBe('1');
    expect(doc).toBeTruthy();
  });
});
