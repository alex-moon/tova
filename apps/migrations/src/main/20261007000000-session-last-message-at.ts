import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Backfills lastMessageAt from the newest message per session and adds the compound listing index.
// @see #226
export class SessionLastMessageAt implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const collections = await db.listCollections({ name: 'sessions' }).toArray();
    if (collections.length === 0) {
      await db.createCollection('sessions');
    }

    const existing = await db.collection('sessions').indexes();
    const hasIndex = existing.some(
      (idx) =>
        idx.key && idx.key.userId === 1 && idx.key.deletedAt === 1 && idx.key.lastMessageAt === -1,
    );
    if (!hasIndex) {
      await db.collection('sessions').createIndex({ userId: 1, deletedAt: 1, lastMessageAt: -1 });
    }

    const latest = await db
      .collection('messages')
      .aggregate([
        { $match: { sessionId: { $ne: null } } },
        { $group: { _id: '$sessionId', lastMessageAt: { $max: '$timestamp' } } },
      ])
      .toArray();

    if (latest.length > 0) {
      await db.collection('sessions').bulkWrite(
        latest.map((row) => ({
          updateOne: {
            filter: { _id: row._id },
            update: { $set: { lastMessageAt: row.lastMessageAt } },
          },
        })),
      );
    }
  }

  async down(db: Db): Promise<void> {
    try {
      await db.collection('sessions').dropIndex({ userId: 1, deletedAt: 1, lastMessageAt: -1 });
    } catch {
      // Index already absent — nothing to drop.
    }
    await db.collection('sessions').updateMany({}, { $unset: { lastMessageAt: '' } });
  }
}
