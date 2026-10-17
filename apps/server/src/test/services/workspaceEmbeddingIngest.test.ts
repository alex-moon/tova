import mongoose from 'mongoose';
import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';
import { WorkspaceEmbedding } from '../../main/models/WorkspaceEmbedding';
import {
  embedWorkspaceSlice,
  embedWorkspaceUser,
} from '../../main/services/workspaceEmbeddingIngest';

/* Ingest/backfill core: `embedWorkspaceSlice` is the hooks' write path, `embedWorkspaceUser` the backfill/eval path; the flag gate and the idempotency rule are the two invariants worth pinning. */
// @see #294
describe('workspaceEmbeddingIngest (#294)', () => {
  const original = process.env.WORKSPACE_MEMORY_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.WORKSPACE_MEMORY_ENABLED;
    else process.env.WORKSPACE_MEMORY_ENABLED = original;
  });

  const userId = new mongoose.Types.ObjectId().toHexString();

  it('does nothing when the feature is off (no provider call, no write)', async () => {
    delete process.env.WORKSPACE_MEMORY_ENABLED;
    const embed = jest.fn();
    await embedWorkspaceSlice(
      { userId, kind: 'chat', sourceId: 'm-off', source: { kind: 'chat', content: 'hello' } },
      { embed },
    );
    expect(embed).not.toHaveBeenCalled();
    expect(await WorkspaceEmbedding.countDocuments({})).toBe(0);
  });

  it('embeds the trimmed text and upserts the row when the feature is on', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const embed = jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    await embedWorkspaceSlice(
      {
        userId,
        kind: 'chat',
        sourceId: 'm-on',
        source: { kind: 'chat', content: '  hello world  ' },
      },
      { embed },
    );
    expect(embed).toHaveBeenCalledWith(['hello world']);
    const row = await WorkspaceEmbedding.findOne({ sourceId: 'm-on' }).lean();
    expect(row).toMatchObject({ kind: 'chat', sourceId: 'm-on' });
    expect(row?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('skips an empty slice without a provider call', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const embed = jest.fn();
    await embedWorkspaceSlice(
      { userId, kind: 'chat', sourceId: 'm-empty', source: { kind: 'chat', content: '   ' } },
      { embed },
    );
    expect(embed).not.toHaveBeenCalled();
    expect(await WorkspaceEmbedding.countDocuments({ sourceId: 'm-empty' })).toBe(0);
  });

  it('swallows a provider failure and writes nothing', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const embed = jest.fn().mockRejectedValue(new Error('provider down'));
    await expect(
      embedWorkspaceSlice(
        { userId, kind: 'chat', sourceId: 'm-throw', source: { kind: 'chat', content: 'hi' } },
        { embed },
      ),
    ).resolves.toBeUndefined();
    expect(await WorkspaceEmbedding.countDocuments({ sourceId: 'm-throw' })).toBe(0);
  });

  it('re-embeds a changed slice and skips an unchanged one (backfill idempotency)', async () => {
    const uid = new mongoose.Types.ObjectId();
    const session = await Session.create({
      userId: uid,
      title: 'Budget chat',
      lastMessageAt: new Date(),
    });
    const message = await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'we agreed the budget is twelve thousand',
      timestamp: new Date(),
    });
    const embed = jest.fn().mockResolvedValue([[0.5, 0.6]]);

    const first = await embedWorkspaceUser(uid.toHexString(), { embed });
    expect(first.pending).toBe(1);
    expect(first.embedded).toBe(1);

    const second = await embedWorkspaceUser(uid.toHexString(), { embed });
    expect(second.pending).toBe(0);
    expect(second.skipped).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);

    await Message.updateOne(
      { _id: message._id },
      { $set: { content: 'the budget is now twenty' } },
    );
    const third = await embedWorkspaceUser(uid.toHexString(), { embed });
    expect(third.pending).toBe(1);
    expect(third.embedded).toBe(1);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('plans without embedding on a dry run', async () => {
    const uid = new mongoose.Types.ObjectId();
    const session = await Session.create({
      userId: uid,
      title: 'Notes',
      lastMessageAt: new Date(),
    });
    await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'remember the hotel is booked',
      timestamp: new Date(),
    });
    const embed = jest.fn().mockResolvedValue([[1]]);
    const result = await embedWorkspaceUser(uid.toHexString(), { embed, dryRun: true });
    expect(result.pending).toBe(1);
    expect(result.embedded).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(await WorkspaceEmbedding.countDocuments({})).toBe(0);
  });
});
