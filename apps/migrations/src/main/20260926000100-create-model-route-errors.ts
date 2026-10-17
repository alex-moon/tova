import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates the modelrouteerrors collection and its unique tally key index so the tally cannot race a lazy-create.
// @see #175
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
