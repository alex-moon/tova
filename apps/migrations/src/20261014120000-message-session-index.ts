import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #293 (closing the #226 deferred follow-up): the workspace-memory retrieval
 * read now scans the user's whole chat corpus, filtering `messages` by the
 * `sessionId` set of their non-deleted sessions. The per-session history reads
 * already sort by `{ sessionId, timestamp }` (`routes/chat.ts`), so a compound
 * `{ sessionId: 1, timestamp: -1 }` index backs both the new corpus read and
 * those hot history reads. A single-field-prefix index serves ascending and
 * descending sorts alike, so one index covers both directions.
 *
 * Index creation is existence-checked (the #175/#226 pattern) so a re-run after
 * a partially applied migration cannot error on an existing index. The
 * `messages` collection is created if absent so a fresh database migrates
 * cleanly.
 */
export class MessageSessionIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const collections = await db.listCollections({ name: 'messages' }).toArray();
    if (collections.length === 0) {
      await db.createCollection('messages');
    }

    const existing = await db.collection('messages').indexes();
    const hasIndex = existing.some(
      (idx) => idx.key && idx.key.sessionId === 1 && idx.key.timestamp === -1,
    );
    if (!hasIndex) {
      await db.collection('messages').createIndex({ sessionId: 1, timestamp: -1 });
    }
  }

  async down(db: Db): Promise<void> {
    try {
      await db.collection('messages').dropIndex({ sessionId: 1, timestamp: -1 });
    } catch {
      // Index already absent — nothing to drop.
    }
  }
}
