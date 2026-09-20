import mongoose from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { purgeUserChats } from './profile';

// Direct unit coverage for `purgeUserChats` (plan 136, T5). The route-level
// first-enable behaviour lives in profile.test.ts (issue #116); this file adds
// what that file does not assert: the bulk-op shape (no per-doc loops), the
// user scoping, and the "assets survive a purge" shipped decision.

const userId = () => new mongoose.Types.ObjectId();

const seedUserChat = async (uid: mongoose.Types.ObjectId, count = 2) => {
  for (let i = 0; i < count; i++) {
    const session = await Session.create({ userId: uid, title: `Chat ${i}` });
    await Message.create([
      { sessionId: session._id, role: 'user', content: `question ${i}` },
      { sessionId: session._id, role: 'assistant', content: `answer ${i}` },
    ]);
  }
};

describe('purgeUserChats (plan 136 T5)', () => {
  const spies = {
    find: jest.spyOn(Session, 'find'),
    updateMany: jest.spyOn(Session, 'updateMany'),
    sessionDeleteMany: jest.spyOn(Session, 'deleteMany'),
    messageDeleteMany: jest.spyOn(Message, 'deleteMany'),
  };

  beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear();
  });

  it('soft-deletes owned sessions via one updateMany, never via deleteMany', async () => {
    const uid = userId();
    await seedUserChat(uid);

    await purgeUserChats(uid);

    expect(spies.find).toHaveBeenCalledWith({ userId: uid });
    expect(spies.updateMany).toHaveBeenCalledWith(
      { userId: uid, deletedAt: null },
      expect.objectContaining({ $set: { deletedAt: expect.any(Date) } }),
    );
    // Sessions are soft-deleted (recoverable unlisting), never removed.
    expect(spies.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it('hard-deletes messages across all owned sessions with one $in bulk op', async () => {
    const uid = userId();
    await seedUserChat(uid);

    await purgeUserChats(uid);

    expect(spies.messageDeleteMany).toHaveBeenCalledWith({
      sessionId: { $in: expect.arrayContaining([expect.any(mongoose.Types.ObjectId)]) },
    });
    expect(spies.messageDeleteMany).toHaveBeenCalledTimes(1);
  });

  it('acts per bulk model calls only: no per-doc loops (find returns lean _ids)', async () => {
    const uid = userId();
    const sessions = await seedReturningSessions(uid, 3);

    await purgeUserChats(uid);

    expect(spies.find).toHaveBeenCalledTimes(1);
    expect(spies.updateMany).toHaveBeenCalledTimes(1);
    expect(spies.messageDeleteMany).toHaveBeenCalledTimes(1);
    // The $in filter targets exactly the user's session ids.
    expect(spies.messageDeleteMany).toHaveBeenCalledWith({
      sessionId: {
        $in: sessions.map((s) => s._id),
      },
    });
  });

  it('scopes to the given user: a different user’s chats are untouched', async () => {
    const owner = userId();
    const other = userId();
    await seedUserChat(owner);
    await seedUserChat(other);

    await purgeUserChats(owner);

    // Owner: session unlisted, messages gone.
    expect(await Session.find({ userId: owner, deletedAt: null }).lean()).toHaveLength(0);
    expect(await Message.countDocuments()).toBe(4);

    // Other user: nothing changed.
    const otherSessions = await Session.find({ userId: other, deletedAt: null }).lean();
    expect(otherSessions).toHaveLength(2);
    expect(await Message.countDocuments({ sessionId: otherSessions[0]._id })).toBe(2);
  });

  it('includes already-soft-deleted sessions in the message sweep', async () => {
    const uid = userId();
    const active = await Session.create({ userId: uid, title: 'active' });
    const orphaned = await Session.create({
      userId: uid,
      title: 'orphaned',
      deletedAt: new Date(),
    });
    await Message.create([
      { sessionId: active._id, role: 'user', content: 'a' },
      { sessionId: orphaned._id, role: 'user', content: 'b' },
    ]);

    await purgeUserChats(uid);

    expect(await Message.countDocuments({ sessionId: { $in: [active._id, orphaned._id] } })).toBe(
      0,
    );
  });

  it('is a no-op for a user with no sessions', async () => {
    const uid = userId();
    await expect(purgeUserChats(uid)).resolves.toBeUndefined();
    expect(await Message.countDocuments()).toBe(0);
  });

  it('leaves the user’s assets alone (shipped decision: assets are the reusable library)', async () => {
    const uid = userId();
    await Asset.create({
      userId: uid,
      filename: 'notes.md',
      key: `${uid}/asset-1/notes.md`,
      contentType: 'text/markdown',
      size: 10,
      status: 'ready',
    });

    await purgeUserChats(uid);

    const assets = await Asset.find({ userId: uid }).lean();
    expect(assets).toHaveLength(1);
    expect(assets[0].filename).toBe('notes.md');
  });
});

const seedReturningSessions = async (uid: mongoose.Types.ObjectId, count: number) => {
  const sessions: Array<{ _id: unknown }> = [];
  for (let i = 0; i < count; i++) {
    const session = await Session.create({ userId: uid, title: `Chat ${i}` });
    sessions.push(session);
    await Message.create([
      { sessionId: session._id, role: 'user', content: `question ${i}` },
      { sessionId: session._id, role: 'assistant', content: `answer ${i}` },
    ]);
  }
  return sessions;
};
