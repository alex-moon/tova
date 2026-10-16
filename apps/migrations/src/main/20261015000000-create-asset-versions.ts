import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #325: content-version snapshots for assistant-generated files. Every
 * `edit_file` write / restore stores the pre-write and new content here; the
 * unique `{ assetId, version }` index is what makes the write path's upsert
 * idempotent. Pre-create the collection and its indexes so deployed instances
 * have them before first write (same stance as create-eval-runs).
 */
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
