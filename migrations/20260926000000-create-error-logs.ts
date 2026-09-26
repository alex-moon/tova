import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #175: durable error log storage. logService mirrors every error-level
 * entry into this collection; the migration pre-creates the collection and
 * the createdAt index so deployed instances have it before first write and
 * no lazy-create flakiness.
 */
export class CreateErrorLogs implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'errorlogs') return;
    }
    await db.createCollection('errorlogs');
    await db.collection('errorlogs').createIndex({ createdAt: 1 });
  }

  async down(db: Db): Promise<void> {
    await db.collection('errorlogs').drop();
  }
}
