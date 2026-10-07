import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #226: sessions are listed by most recent message, so the compound
 * `{ userId, deletedAt, lastMessageAt }` index backs the listing sort and a
 * one-off backfill seeds `lastMessageAt` from the newest message in each
 * session. Sessions with no messages keep `lastMessageAt: null` and sort last
 * (see the listing route); we deliberately do not seed them from `createdAt`,
 * which would make an empty session look messaged.
 *
 * `messages` holds headers, so the backfill is a single grouped `$max`
 * aggregation rather than a per-session round-trip. Index creation is
 * existence-checked (same pattern as the #175 migrations) so a re-run after a
 * partially applied migration cannot error on an existing index.
 *
 * Out of scope: a `{ sessionId: 1, timestamp: 1 }` index on `messages` — noted
 * as a follow-up on #226, not implemented here.
 */
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
