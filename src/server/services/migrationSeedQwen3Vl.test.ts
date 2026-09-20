import { Db } from 'mongodb';
import mongoose from 'mongoose';
import { ReviseVisionPoolRouting } from '../../../migrations/20260920100000-revise-vision-pool-routing';
import { SeedQwen3VlRouting } from '../../../migrations/20260920000000-seed-qwen3-vl-routing';

/*
 * The migration must upgrade the post-#94 pool shape (the deployed state:
 * pools are non-empty, so app-level seeding never fires) so existing
 * deployments actually receive the #115 vision row.
 */
const DEPLOYED_ROWS = [
  {
    provider: 'deepinfra',
    model: 'openai/gpt-oss-20b',
    tier: 'small',
    tools: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'google/gemma-3-4b-it',
    tier: 'small',
    tools: true,
    vision: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-14B',
    tier: 'small',
    tools: true,
    contextLength: 40960,
  },
  {
    provider: 'deepinfra',
    model: 'openai/gpt-oss-120b',
    tier: 'large',
    tools: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    tier: 'large',
    tools: true,
    contextLength: 262144,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    tier: 'large',
    tools: true,
    contextLength: 163840,
  },
  {
    provider: 'deepinfra',
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tier: 'large',
    tools: true,
    contextLength: 1048576,
  },
];

describe('migration SeedQwen3VlRouting', () => {
  let db: Db;

  beforeAll(() => {
    db = mongoose.connection.db as unknown as Db;
  });

  it('up applies the #115 revision to a non-empty pool and down restores it', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedQwen3VlRouting().up(db);
    await new ReviseVisionPoolRouting().up(db);
    // VL-8B re-tiered small->large, VL-30B added, net +2 rows; gemma stays.
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length + 2);
    const reTiered = await db.collection('providerroutings').findOne({
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    expect(reTiered).toMatchObject({
      provider: 'deepinfra',
      tier: 'large',
      eligible: true,
      tools: true,
      vision: true,
      contextLength: 262144,
    });
    expect(
      await db.collection('providerroutings').countDocuments({
        model: 'Qwen/Qwen3-VL-8B-Instruct',
        tier: 'small',
      }),
    ).toBe(0);
    const added = await db.collection('providerroutings').findOne({
      model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    });
    expect(added).toMatchObject({
      provider: 'deepinfra',
      tier: 'large',
      eligible: true,
      tools: true,
      vision: true,
      contextLength: 262144,
    });
    const gemma = await db.collection('providerroutings').findOne({
      model: 'google/gemma-3-4b-it',
    });
    expect(gemma).toMatchObject({ eligible: false });

    await new ReviseVisionPoolRouting().down(db);
    // Down removes the two large vision rows, restores the small VL-8B row
    // (7 deployed rows + the small VL-8B from the first #115 migration) and
    // re-enables gemma.
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length + 1);
    expect(
      await db.collection('providerroutings').countDocuments({
        model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
      }),
    ).toBe(0);
    const restored = await db.collection('providerroutings').findOne({
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    expect(restored).toMatchObject({ tier: 'small', eligible: true });
    expect(
      await db.collection('providerroutings').findOne({
        model: 'google/gemma-3-4b-it',
      }),
    ).toMatchObject({ eligible: true });
  });

  it('up is idempotent against seeded-client databases that already carry the rows', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedQwen3VlRouting().up(db);
    await new ReviseVisionPoolRouting().up(db);
    await new ReviseVisionPoolRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length + 2);
  });
});
