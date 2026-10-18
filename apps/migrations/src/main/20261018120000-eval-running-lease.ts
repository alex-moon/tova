import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Atomic eval lease: at most one running row, any kind. @see #394
export class EvalRunningLease implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection('evalruns');
    if (
      !(await db.listCollections().toArray()).some((c: { name: string }) => c.name === 'evalruns')
    )
      return;
    // A deploy restarts the server, so every running row is stranded; clear
    // them or the unique partial index cannot build.
    await col.updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'error',
          finishedAt: new Date(),
          error: 'lease reclaimed for unique-index build',
        },
      },
    );
    await col.createIndex(
      { status: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'running' },
        name: 'evalruns_running_lease',
      },
    );
  }

  async down(db: Db): Promise<void> {
    await db.collection('evalruns').dropIndex('evalruns_running_lease');
  }
}
