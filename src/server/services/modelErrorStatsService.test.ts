import { ModelErrorStat } from '../models/ModelErrorStat';
import { recordEndpointError } from './modelErrorStatsService';
import { muteConsoleError } from '../test/muteConsole';

describe('modelErrorStatsService (#168 diagnostics)', () => {
  const readRow = (key: string) =>
    ModelErrorStat.findOne({ provider: 'deepinfra', model: 'test-model', key }).lean<{
      statusCode?: number;
      sample: string;
      count: number;
      lastSeenAt: Date;
    }>();

  it('groups by status code when the error carries one, counting repeats', async () => {
    const err = Object.assign(new Error('upstream exploded'), { statusCode: 502 });
    await recordEndpointError('deepinfra', 'test-model', err);
    await recordEndpointError('deepinfra', 'test-model', err);

    const row = (await readRow('502'))!;
    expect(row.count).toBe(2);
    expect(row.statusCode).toBe(502);
    expect(row.sample).toContain('upstream exploded');
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('groups by redacted message text when no status code is present', async () => {
    await recordEndpointError('deepinfra', 'test-model', new Error('connection reset by peer'));
    await recordEndpointError('deepinfra', 'test-model', new Error('connection reset by peer'));
    await recordEndpointError('deepinfra', 'test-model', new Error('a different failure'));

    expect((await readRow('connection reset by peer'))!.count).toBe(2);
    expect((await readRow('a different failure'))!.count).toBe(1);
    // A message-shaped group never persists a statusCode field.
    expect((await readRow('connection reset by peer'))!.statusCode).toBeUndefined();
  });

  it('separates groups per provider+model (same key, different endpoint)', async () => {
    const err = Object.assign(new Error('gateway timeout'), { statusCode: 504 });
    await recordEndpointError('deepinfra', 'test-model', err);
    await recordEndpointError('groq', 'other-model', err);
    expect(await ModelErrorStat.countDocuments({ key: '504' })).toBe(2);
  });

  it('redacts prompt-shaped content out of the key and caps the sample', async () => {
    const secret = 'x'.repeat(200);
    const err = new Error(`provider echoed the prompt {"user_prompt":"${secret}"}`);
    await recordEndpointError('deepinfra', 'test-model', err);

    const rows = await ModelErrorStat.find({ provider: 'deepinfra', model: 'test-model' }).lean<
      { key: string; sample: string }[]
    >();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).not.toContain(secret);
    expect(rows[0].key.length).toBeLessThanOrEqual(200);
    expect(rows[0].sample.length).toBeLessThanOrEqual(500);
    expect(rows[0].sample).not.toContain(secret);
  });

  it('falls back to an "unknown" key for an empty message', async () => {
    await recordEndpointError('deepinfra', 'test-model', new Error(''));
    expect((await readRow('unknown'))!.count).toBe(1);
  });

  it('swallows write failures so diagnostics never mask the real error', async () => {
    const spy = jest.spyOn(ModelErrorStat, 'updateOne').mockRejectedValue(new Error('db down'));
    const consoleErrorSpy = muteConsoleError();
    try {
      await expect(
        recordEndpointError('deepinfra', 'test-model', new Error('upstream 500')),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
