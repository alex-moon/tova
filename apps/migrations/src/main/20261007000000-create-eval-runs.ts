import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates the evalruns collection and its indexes so deployed instances have them before first write.
// @see #225
export class CreateEvalRuns implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'evalruns') return;
    }
    await db.createCollection('evalruns');
    await db.collection('evalruns').createIndex({ startedAt: -1 });
    await db.collection('evalruns').createIndex({ status: 1, startedAt: -1 });
  }

  async down(db: Db): Promise<void> {
    await db.collection('evalruns').drop();
  }
}
