import { Db } from 'mongodb';
import mongoose from 'mongoose';
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

  it('up inserts the vision row into a non-empty pool and down removes only it', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedQwen3VlRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length + 1);
    const inserted = await db.collection('providerroutings').findOne({
      model: 'Qwen/Qwen3-VL-8B-Instruct',
    });
    expect(inserted).toMatchObject({
      provider: 'deepinfra',
      tier: 'small',
      eligible: true,
      tools: true,
      vision: true,
      contextLength: 262144,
    });

    await new SeedQwen3VlRouting().down(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length);
    expect(
      await db.collection('providerroutings').countDocuments({
        model: 'Qwen/Qwen3-VL-8B-Instruct',
      }),
    ).toBe(0);
  });

  it('up is idempotent against seeded-client databases that already carry the row', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedQwen3VlRouting().up(db);
    await new SeedQwen3VlRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length + 1);
  });
});
