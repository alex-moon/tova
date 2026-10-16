import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #329 (epic #328): the MCP-server registry becomes the connector registry.
 * `mcpservers` is renamed to `connectors` (same-database renameCollection is
 * a metadata operation — the documents and all indexes, including the unique
 * per-user (scope, userId, url) index, ride along untouched), and every row
 * is backfilled with `type: 'mcp.pat'`, the only storable connector type
 * today. Down removes the backfilled field and renames back (run #327's down
 * first once it exists — this down predates the mcp.oauth vault fields).
 */
export class RenameMcpserversToConnectors implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const names = new Set((await db.listCollections().toArray()).map((c) => c.name));
    // Fresh install: nothing to rename; the backfill below is a no-op on the
    // (nonexistent) connectors collection.
    if (names.has('mcpservers')) {
      if (names.has('connectors')) {
        // Crash-window ambiguity: refuse to guess rather than merge silently.
        throw new Error('both mcpservers and connectors exist; resolve manually');
      }
      await db.admin().command({
        renameCollection: `${db.databaseName}.mcpservers`,
        to: `${db.databaseName}.connectors`,
      });
    }
    // Unconditional + idempotent so a run that died between the rename and
    // this backfill completes on re-run (the type-less rows would otherwise
    // stay untyped forever: the early return marks the migration applied).
    await db
      .collection('connectors')
      .updateMany({ type: { $exists: false } }, { $set: { type: 'mcp.pat' } });
  }

  async down(db: Db): Promise<void> {
    const names = new Set((await db.listCollections().toArray()).map((c) => c.name));
    if (!names.has('connectors')) return;
    if (names.has('mcpservers')) {
      throw new Error('mcpservers already exists; refusing to overwrite');
    }
    await db.collection('connectors').updateMany({}, { $unset: { type: '' } });
    await db.admin().command({
      renameCollection: `${db.databaseName}.connectors`,
      to: `${db.databaseName}.mcpservers`,
    });
  }
}
