import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates the assetversions collection and the unique { assetId, version } index that makes the write-path upsert idempotent.
// @see #325
export class CreateAssetVersions implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const name of await db.listCollections().toArray()) {
      if (name.name === 'assetversions') return;
    }
    await db.createCollection('assetversions');
    await db.collection('assetversions').createIndex({ assetId: 1, version: 1 }, { unique: true });
  }

  async down(db: Db): Promise<void> {
    await db.collection('assetversions').drop();
  }
}
