import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Forwards-only drop of the retired entities/entityedges collections.
// @see #256 #251 #138 #253
export class DropEntityGraph implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'entities' || name.name === 'entityedges') {
        await db.collection(name.name).drop();
      }
    }
  }

  async down(): Promise<void> {
    // Forward-only: the extracted graph rows have no source to restore from.
  }
}
