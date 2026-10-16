import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #256 (epic #251): drop the retired entity-graph collections.
 *
 * #138's entity graph is superseded by the epic — the unit of memory is a
 * piece of work, not an extracted concept — and #253's workspace-memory
 * retrieval is its replacement. The owner decision (2026-10-11) settled the
 * data disposition as **drop**: the graph is unused, so nothing needs
 * preserving. This forwards-only migration removes the `entities` and
 * `entityedges` collections. `down` is a guard no-op: the extracted rows
 * cannot be reconstructed.
 */
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
