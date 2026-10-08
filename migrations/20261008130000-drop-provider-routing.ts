import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #246: drop the dead `providerroutings` collection.
 *
 * The tier-era `ProviderRouting` model was deleted once #235 moved cost
 * tracking onto `ModelRoster` provider prices (#235) and #234 reworked the
 * admin Models tab onto the `modelroster` collection. No app code reads the
 * collection any more, so this forwards-only migration removes the lingering
 * legacy data. `down` is a guard no-op: the tier-shaped rows cannot be
 * reconstructed (their seed migrations were deleted in #233).
 */
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
