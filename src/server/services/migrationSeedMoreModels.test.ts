import { Db } from 'mongodb';
import mongoose from 'mongoose';
import { SeedMoreModelsRouting } from '../../../migrations/20260926000200-seed-more-models-routing';

/*
 * The migration must upgrade the deployed pool shape as of this branch
 * (10 rows: 3 small incl. the ineligible gemma, 6 large incl. both #115 VL
 * rows, 1 guard) so existing deployments actually receive the 14 #170 rows —
 * app-level seeding never fires on a non-empty collection.
 */
const DEPLOYED_ROWS = [
  {
    provider: 'deepinfra',
    model: 'openai/gpt-oss-20b',
    tier: 'small',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'google/gemma-3-4b-it',
    tier: 'small',
    eligible: false,
    tools: true,
    vision: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-14B',
    tier: 'small',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 40960,
  },
  {
    provider: 'deepinfra',
    model: 'openai/gpt-oss-120b',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 262144,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 163840,
  },
  {
    provider: 'deepinfra',
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 1048576,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-8B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
  },
  {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    tier: 'guard',
    eligible: true,
    tools: true,
    vision: false,
  },
];

describe('migration SeedMoreModelsRouting', () => {
  let db: Db;

  beforeAll(() => {
    db = mongoose.connection.db as unknown as Db;
  });

  it('up inserts the 14 #170 rows with field-complete shapes, down restores the deployed shape', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedMoreModelsRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(
      DEPLOYED_ROWS.length + 14,
    );

    // Spot-check one vision row: raw-driver insert, so vision/disabledUntil
    // must have been carried explicitly by the migration (no schema defaults).
    const visionRow = await db.collection('providerroutings').findOne({
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    });
    expect(visionRow).toMatchObject({
      provider: 'deepinfra',
      tier: 'large',
      eligible: true,
      tools: true,
      vision: true,
      contextLength: 1048576,
      disabledUntil: null,
    });
    // Spot-check one text row: `vision: false` must be present-on-insert.
    const textRow = await db.collection('providerroutings').findOne({ model: 'zai-org/GLM-5.3' });
    expect(textRow).toMatchObject({
      provider: 'deepinfra',
      tier: 'large',
      eligible: true,
      tools: true,
      vision: false,
      contextLength: 1048576,
      disabledUntil: null,
    });

    await new SeedMoreModelsRouting().down(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(DEPLOYED_ROWS.length);
    for (const { provider, model, tier } of DEPLOYED_ROWS) {
      expect(
        await db.collection('providerroutings').countDocuments({ provider, model, tier }),
      ).toBe(1);
    }
  });

  it('up is idempotent on an already-migrated database', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    await new SeedMoreModelsRouting().up(db);
    await new SeedMoreModelsRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(
      DEPLOYED_ROWS.length + 14,
    );
  });

  it('up never clobbers admin edits to existing rows (deletion in admin sticks)', async () => {
    await db.collection('providerroutings').insertMany(DEPLOYED_ROWS);
    // An admin deleted Kimi-K3 before the migration ran: the row exists with
    // `eligible: false`. `$setOnInsert` must leave it untouched.
    await db.collection('providerroutings').insertOne({
      provider: 'deepinfra',
      model: 'moonshotai/Kimi-K3',
      tier: 'large',
      eligible: false,
      tools: true,
      vision: true,
      contextLength: 1048576,
      disabledUntil: null,
    });
    await new SeedMoreModelsRouting().up(db);
    expect(await db.collection('providerroutings').countDocuments()).toBe(
      DEPLOYED_ROWS.length + 14,
    );
    const edited = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(edited).toMatchObject({ eligible: false });
  });
});
