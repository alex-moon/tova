import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #289 D14: `evalruns` now serves two suites (tool-use and workspace-memory),
 * disambiguated by a `kind` field. Add the kind-scoped idempotency index and
 * backfill `kind: 'tool-use'` on rows written before the field existed so an
 * old run is never ambiguous.
 */
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
