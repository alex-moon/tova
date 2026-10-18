import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Safe Browsing cache is keyed by full URL now (was host); old rows cannot be
// re-keyed and the stale unique host index collides with url-keyed upserts.
// @see #397 #120
export class SafelinkCachePerUrl implements MigrationInterface {
  async up(db: Db): Promise<void> {
    // A 24h-TTL cache: dropping the collection (docs + both index sets) lets
    // Mongoose rebuild url-unique and TTL indexes from a clean slate at boot.
    await db
      .collection('safebrowsingcaches')
      .drop()
      .catch(() => {});
  }

  async down(_db: Db): Promise<void> {
    // Nothing to restore: the cache refills organically from the live API.
  }
}
