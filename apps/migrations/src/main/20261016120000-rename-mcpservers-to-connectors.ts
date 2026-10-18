import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Renames mcpservers to connectors and backfills type: 'mcp.pat'.
// @see #329 #328 #327
export class RenameMcpserversToConnectors implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const names = new Set((await db.listCollections().toArray()).map((c) => c.name));
    // Fresh install: nothing to rename; the backfill below is a no-op.
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
    // Idempotent so a run that died mid-rename completes on re-run.
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
