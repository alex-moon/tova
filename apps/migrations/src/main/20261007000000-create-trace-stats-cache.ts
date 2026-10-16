import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #224: cache for the admin Traces per-model summary. A background poller
 * upserts one document per stats window; the read route serves it instead of
 * a live LangSmith sweep. The migration pre-creates the collection and the
 * windowKey unique index so deployed instances have them before first write
 * and the poller's upsert cannot lazy-create index flakiness.
 */
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
