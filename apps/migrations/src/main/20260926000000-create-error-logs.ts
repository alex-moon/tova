import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates the errorlogs collection and createdAt index before first write.
// @see #175
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
