import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates the tracestatscaches collection and the windowKey unique index so the poller's upsert cannot race a lazy-create.
// @see #224
export class CreateTraceStatsCache implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'tracestatscaches') return;
    }
    await db.createCollection('tracestatscaches');
    await db.collection('tracestatscaches').createIndex({ windowKey: 1 }, { unique: true });
  }

  async down(db: Db): Promise<void> {
    await db.collection('tracestatscaches').drop();
  }
}
