import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates tracestatscaches + windowKey unique index for poller upserts.
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
