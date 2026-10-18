import mongoose from 'mongoose';
import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';

/* Index presence: hot per-turn reads and the sidebar sort must not scan. */
// @see #377

const indexKeys = async (collection: mongoose.Collection): Promise<string[]> => {
  const indexes = await collection.listIndexes().toArray();
  return indexes.map((i) => JSON.stringify(i.key));
};

describe('hot-path indexes (#377)', () => {
  it('Message carries the per-session newest-first index', async () => {
    const keys = await indexKeys(Message.collection);
    expect(keys).toContain(JSON.stringify({ sessionId: 1, timestamp: -1 }));
  });

  it('Session carries the sidebar index', async () => {
    const keys = await indexKeys(Session.collection);
    expect(keys).toContain(JSON.stringify({ userId: 1, deletedAt: 1, lastMessageAt: -1 }));
  });
});
