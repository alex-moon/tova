import mongoose from 'mongoose';
import { Message } from '../../../main/models/Message';
import { Session } from '../../../main/models/Session';
import { WorkspaceEmbedding } from '../../../main/models/WorkspaceEmbedding';
import { config } from '../../../main/config/index';
import { embedTexts } from '../../../main/services/workspace/embeddingService';
import { embeddingTextHash } from '../../../main/services/workspace/workspaceEmbeddingText';
import {
  drainUserEmbeddings,
  embedWorkspaceSlice,
  embedWorkspaceUser,
  enqueueWorkspaceEmbedding,
} from '../../../main/services/workspace/workspaceEmbeddingIngest';

jest.mock('../../../main/services/workspace/embeddingService');

/* Ingest/backfill core: flag gate and idempotency are the invariants. */
// @see #294
describe('workspaceEmbeddingIngest (#294)', () => {
  const original = process.env.WORKSPACE_MEMORY_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.WORKSPACE_MEMORY_ENABLED;
    else process.env.WORKSPACE_MEMORY_ENABLED = original;
    jest.resetAllMocks();
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

  it('re-embeds a row whose dim no longer matches the config (#393)', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const uid = new mongoose.Types.ObjectId();
    const session = await Session.create({
      userId: uid,
      title: 'Dim shift',
      lastMessageAt: new Date(),
    });
    const message = await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'the budget is twelve thousand',
      timestamp: new Date(),
    });
    const text = 'the budget is twelve thousand';
    await WorkspaceEmbedding.create({
      userId: uid,
      kind: 'chat',
      sourceId: String(message._id),
      model: config.embeddings.model,
      dim: config.embeddings.dim + 1,
      vector: [0.1],
      // The hash matches; only the stale dim may force the re-embed.
      textHash: embeddingTextHash(text, config.embeddings.model),
    });
    const embed = jest.fn().mockResolvedValue([[0.5, 0.6]]);
    const result = await embedWorkspaceUser(uid.toHexString(), { embed });
    // The stale-dim row never satisfies the skip; the upsert overwrites it.
    expect(result.skipped).toBe(0);
    expect(result.embedded).toBe(1);
    const row = await WorkspaceEmbedding.findOne({ sourceId: String(message._id) }).lean();
    expect(row?.dim).toBe(config.embeddings.dim);
  });

  it('drainUserEmbeddings waits for an in-flight ingest to settle (#393)', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(embedTexts).mockImplementation(() => gate.then(() => [[0.1, 0.2]]));
    enqueueWorkspaceEmbedding({
      userId,
      kind: 'chat',
      sourceId: 'drain-1',
      source: { kind: 'chat', content: 'settle me' },
    });
    let drained = false;
    const drain = drainUserEmbeddings(userId).then(() => {
      drained = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
    } finally {
      release();
    }
    await drain;
    expect(drained).toBe(true);
    expect(await WorkspaceEmbedding.countDocuments({ sourceId: 'drain-1' })).toBe(1);
  });

  it('drainUserEmbeddings resolves when nothing is in flight (#393)', async () => {
    await expect(drainUserEmbeddings('nobody')).resolves.toBeUndefined();
  });
});
