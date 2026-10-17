import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Forwards-only drop of the dead providerroutings collection; no app code reads it any more.
// @see #246 #235 #234 #233
export class DropProviderRouting implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'providerroutings') {
        await db.collection('providerroutings').drop();
        return;
      }
    }
  }

  async down(): Promise<void> {
    // Forward-only: the tier-shaped rows have no source to restore from.
  }
}
