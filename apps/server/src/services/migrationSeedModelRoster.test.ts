import { Db } from 'mongodb';
import mongoose from 'mongoose';
import { SeedModelRoster } from '../../../migrations/src/20261008000000-seed-model-roster';
import { ROSTER_SEED } from './rosterConfig';

/*
 * #232: the roster migration must upgrade a deployed database to the fixed
 * model roster. App-level seeding only recovers an EMPTY `modelrosters`
 * collection, so an upgrade needs this migration. The test also pins the
 * migration rows to `ROSTER_SEED` so the two sources cannot drift.
 */

describe('migration SeedModelRoster', () => {
  let db: Db;

  beforeAll(() => {
    db = mongoose.connection.db as unknown as Db;
  });

  it('up inserts the three roster models with both providers, down removes them', async () => {
    await new SeedModelRoster().up(db);
    expect(await db.collection('modelrosters').countDocuments()).toBe(ROSTER_SEED.length);

    const flash = await db
      .collection('modelrosters')
      .findOne({ modelId: 'deepseek-ai/DeepSeek-V4.1-Flash' });
    expect(flash).toMatchObject({
      label: 'DeepSeek V4.1 Flash',
      tools: true,
      vision: true,
      contextLength: 1048576,
      inputPrice: 0.2,
      outputPrice: 0.6,
      eligible: true,
    });
    expect(flash?.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'deepinfra' }),
        expect.objectContaining({
          provider: 'fireworks',
          modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
        }),
      ]),
    );

    // MiniMax M3 must be text-only (excluded from image turns).
    const minimax = await db
      .collection('modelrosters')
      .findOne({ modelId: 'MiniMaxAI/MiniMax-M3' });
    expect(minimax).toMatchObject({ vision: false });

    await new SeedModelRoster().down(db);
    expect(await db.collection('modelrosters').countDocuments()).toBe(0);
  });

  it('up is idempotent on an already-migrated database', async () => {
    await new SeedModelRoster().up(db);
    await new SeedModelRoster().up(db);
    expect(await db.collection('modelrosters').countDocuments()).toBe(ROSTER_SEED.length);
  });

  it('pins the migration rows to ROSTER_SEED (no drift)', async () => {
    await new SeedModelRoster().up(db);
    for (const seed of ROSTER_SEED) {
      const row = await db.collection('modelrosters').findOne({ modelId: seed.modelId });
      expect(row).toMatchObject({
        label: seed.label,
        tools: seed.tools,
        vision: seed.vision,
        contextLength: seed.contextLength,
        inputPrice: seed.inputPrice,
        outputPrice: seed.outputPrice,
        eligible: true,
      });
      const rows = row?.providers as Array<{
        provider: string;
        modelId: string;
        inputPrice?: number;
        outputPrice?: number;
      }>;
      for (const p of seed.providers) {
        // Per-provider identity AND price must match the seed (#235): one model
        // has two providers whose prices differ, so drift here would misprice
        // every raced turn.
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider: p.provider,
              modelId: p.modelId,
              inputPrice: p.inputPrice,
              outputPrice: p.outputPrice,
            }),
          ]),
        );
      }
    }
  });
});
