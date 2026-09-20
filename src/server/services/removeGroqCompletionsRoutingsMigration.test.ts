import type { Db } from 'mongodb';
import mongoose from 'mongoose';
import { RemoveGroqCompletionsRoutings } from '../../../migrations/20260919000000-remove-groq-completions-routings';
import { ProviderRouting } from '../models/ProviderRouting';

const seed = async () =>
  ProviderRouting.collection.insertMany([
    // Pre-branch seeding shape: groq completion pools, guard default allam.
    { provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'small', eligible: true },
    { provider: 'groq', model: 'google/gemma-3-4b-it', tier: 'small', eligible: true },
    { provider: 'groq', model: 'Qwen/Qwen2.5-72B-Instruct', tier: 'large', eligible: true },
    { provider: 'groq', model: 'allam-2-7b', tier: 'guard', eligible: true },
  ]);

const docs = async () => ProviderRouting.collection.find().sort({ tier: 1, model: 1 }).toArray();

describe('RemoveGroqCompletionsRoutings migration', () => {
  it('sweeps stale groq rows and upserts the DeepInfra pool', async () => {
    await seed();
    await new RemoveGroqCompletionsRoutings().up(mongooseDb());

    expect(await ProviderRouting.countDocuments({ provider: 'groq' })).toBe(0);
    expect(await ProviderRouting.countDocuments({ model: 'allam-2-7b' })).toBe(0);
    const rows = await docs();
    expect(
      rows.filter((r) => r.tier === 'small' || r.tier === 'large').map((r) => r.model),
    ).toEqual(
      expect.arrayContaining([
        'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
        'deepseek-ai/DeepSeek-V3.2',
        'Qwen/Qwen3-235B-A22B-Instruct-2507',
        'Qwen/Qwen3-14B',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'google/gemma-3-4b-it',
      ]),
    );
    const gemma = rows.find((r) => r.model === 'google/gemma-3-4b-it' && r.tier === 'small');
    expect(gemma).toMatchObject({ provider: 'deepinfra', vision: true, tools: true });
    // Guard tier is swept too (deprecated allam default — env reseeds on first aux call).
    expect(await ProviderRouting.countDocuments({ tier: 'guard' })).toBe(0);
  });

  it('is idempotent when run over an already-migrated pool', async () => {
    await seed();
    const migration = new RemoveGroqCompletionsRoutings();
    await migration.up(mongooseDb());
    const first = await docs();
    await migration.up(mongooseDb());
    expect(await docs()).toEqual(first);
  });

  it('down restores the pre-branch groq rows including the allam guard default', async () => {
    await seed();
    const migration = new RemoveGroqCompletionsRoutings();
    await migration.up(mongooseDb());
    await migration.down(mongooseDb());

    expect(await ProviderRouting.countDocuments({ provider: 'deepinfra' })).toBe(0);
    const rows = await docs();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'groq', model: 'allam-2-7b', tier: 'guard' }),
        expect.objectContaining({
          provider: 'groq',
          model: 'openai/gpt-oss-20b',
          tier: 'small',
        }),
        expect.objectContaining({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          tier: 'large',
        }),
      ]),
    );
  });
});

/* mongoose carries its own driver copy; the Db shapes are compatible at runtime. */
const mongooseDb = (): Db => mongoose.connection.db as unknown as Db;
