import { Db } from 'mongodb';
import mongoose from 'mongoose';
import { BackfillModelPrices } from '../../../migrations/20261002000100-backfill-model-prices';
import { SeedMoreModelsRouting } from '../../../migrations/20260926000200-seed-more-models-routing';
import { routingPrice, sweepModels } from './modelConfigService';

/*
 * #199: unlike the #170 migration (a seed), this one is a backfill — it must
 * `$set` prices onto rows that already exist, while never touching anything
 * else. The seed/migration drift test for #170 pins row shape; this file pins
 * the price half: the migration and SEED_ENTRIES must agree field for field.
 */
describe('migration BackfillModelPrices', () => {
  let db: Db;

  beforeAll(() => {
    db = mongoose.connection.db as unknown as Db;
  });

  it('sets prices on existing #170 rows without disturbing other fields', async () => {
    await new SeedMoreModelsRouting().up(db);
    const before = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(before?.inputPrice).toBeUndefined();

    await new BackfillModelPrices().up(db);

    const kimi = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(kimi).toMatchObject({
      provider: 'deepinfra',
      tier: 'large',
      eligible: true,
      tools: true,
      vision: true,
      contextLength: 1048576,
      inputPrice: 2.85,
      outputPrice: 14.25,
    });

    // 14 #170 rows now carry prices; pre-#170 rows stay unpriced.
    expect(
      await db
        .collection('providerroutings')
        .countDocuments({ inputPrice: { $exists: true }, outputPrice: { $exists: true } }),
    ).toBe(14);
  });

  it('is idempotent', async () => {
    await new SeedMoreModelsRouting().up(db);
    await new BackfillModelPrices().up(db);
    await new BackfillModelPrices().up(db);
    const kimi = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(kimi).toMatchObject({ inputPrice: 2.85, outputPrice: 14.25 });
  });

  it('never clobbers non-price admin edits on re-run', async () => {
    await new SeedMoreModelsRouting().up(db);
    await db
      .collection('providerroutings')
      .updateOne({ model: 'moonshotai/Kimi-K3' }, { $set: { eligible: false } });
    await new BackfillModelPrices().up(db);
    const edited = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(edited).toMatchObject({ eligible: false, inputPrice: 2.85, outputPrice: 14.25 });
  });

  it('down clears only the price fields', async () => {
    await new SeedMoreModelsRouting().up(db);
    await new BackfillModelPrices().up(db);
    await new BackfillModelPrices().down(db);
    const kimi = await db.collection('providerroutings').findOne({
      model: 'moonshotai/Kimi-K3',
    });
    expect(kimi).toMatchObject({ eligible: true, contextLength: 1048576 });
    expect(kimi?.inputPrice).toBeUndefined();
    expect(kimi?.outputPrice).toBeUndefined();
  });

  /*
   * The seed-side half of the contract: every priced #170 SEED_ENTRIES row
   * must match the migration's price exactly, so fresh (app-seeded) and
   * upgraded (migration) databases agree. A future price edit to one side
   * alone fails here.
   */
  it('migration prices match SEED_ENTRIES exactly', async () => {
    const seeded = sweepModels()
      .filter((ref) => ref.tier === 'large')
      .filter((ref) => routingPrice(ref) !== undefined);
    expect(seeded).toHaveLength(14);

    await new SeedMoreModelsRouting().up(db);
    await new BackfillModelPrices().up(db);
    const inserted = await db
      .collection('providerroutings')
      .find({ tier: 'large' }, { projection: { _id: 0, __v: 0 } })
      .toArray();
    const byModel = new Map(inserted.map((row) => [row.model as string, row]));

    for (const ref of seeded) {
      const row = byModel.get(ref.model);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        inputPrice: ref.inputPrice,
        outputPrice: ref.outputPrice,
      });
    }
  });
});
