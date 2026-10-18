import { MigrationInterface, Db } from 'mongo-migrate-ts';

// Adds the compound { sessionId, timestamp } index for message reads.
// @see #293 #226 #175
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
