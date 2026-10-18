import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Pre-creates assetversions and its unique { assetId, version } index upfront.
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
