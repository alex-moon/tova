import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #175: per-provider-route error tally. modelErrorTallyService upserts one
 * row per (provider, model, status, category) — the migration pre-creates
 * the collection and the unique key index so the tally pattern cannot race
 * a lazy-create on first use.
 */
export class CreateModelRouteErrors implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'modelrouteerrors') return;
    }
    await db.createCollection('modelrouteerrors');
    await db
      .collection('modelrouteerrors')
      .createIndex({ provider: 1, model: 1, status: 1, category: 1 }, { unique: true });
  }

  async down(db: Db): Promise<void> {
    await db.collection('modelrouteerrors').drop();
  }
}
