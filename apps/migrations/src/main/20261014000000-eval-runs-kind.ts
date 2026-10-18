import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Backfills kind: 'tool-use' on pre-field rows; adds the kind index.
// @see #289
export class EvalRunsKind implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await db
      .collection('evalruns')
      .updateMany({ kind: { $exists: false } }, { $set: { kind: 'tool-use' } });
    await db.collection('evalruns').createIndex({ kind: 1, startedAt: -1 });
  }

  async down(db: Db): Promise<void> {
    await db.collection('evalruns').dropIndex('kind_1_startedAt_-1');
  }
}
