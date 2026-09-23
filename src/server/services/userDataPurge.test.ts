import mongoose from 'mongoose';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import { McpServer } from '../models/McpServer';
import { purgeAllUserData } from './userDataPurge';

// Data-level coverage for purgeAllUserData (issue #143 T1): every
// PII-bearing collection enumerated in the ticket goes to zero for the
// purging user, user B is untouched, the Spaces sweeps are attempted for
// each asset key and chat prefix, failures are collected per key. The
// storage layer is mocked (pattern: assets.attach.test.ts mocks its
// boundary); the trace purge service is mocked so tracePurge.test.ts covers
// the LangSmith wire format separately.

jest.mock('./storageService', () => ({
  isStorageConfigured: jest.fn(),
  deleteObject: jest.fn(),
  listObjectKeys: jest.fn(),
  getObjectBuffer: jest.fn(),
  getObjectStream: jest.fn(),
  headObject: jest.fn(),
  presignGetUrl: jest.fn(),
  presignPutUrl: jest.fn(),
  putObject: jest.fn(),
}));

jest.mock('./tracePurge', () => ({
  purgeUserTraces: jest.fn(),
}));

// Tests are exempt from the storage-boundary import rule (eslint.config.js).
import { spacesWorkspaceStorage } from './workspaceStorage';
import { listObjectKeys } from './storageService';
import { purgeUserTraces } from './tracePurge';

const mockedDeleteByKey = jest.mocked(spacesWorkspaceStorage.deleteByKey);
const mockedIsConfigured = jest.mocked(spacesWorkspaceStorage.isConfigured);
const mockedListKeys = jest.mocked(listObjectKeys);
const mockedTracePurge = jest.mocked(purgeUserTraces);

const userId = () => new mongoose.Types.ObjectId();

const seedUserWorkspace = async (uid: mongoose.Types.ObjectId, count = 2) => {
  for (let i = 0; i < count; i++) {
    const session = await Session.create({ userId: uid, title: `Chat ${i}` });
    await Message.create([
      { sessionId: session._id, role: 'user', content: `question ${i}` },
      { sessionId: session._id, role: 'assistant', content: `answer ${i}` },
    ]);
  }
};

const seedAssetsAndGraph = async (uid: mongoose.Types.ObjectId) => {
  const asset = await Asset.create({
    userId: uid,
    filename: 'notes.md',
    key: `${uid}/asset-1/notes.md`,
    contentType: 'text/markdown',
    size: 10,
    status: 'ready',
  });
  await AssetJob.create({ assetId: asset._id });
  const entity = await Entity.create({
    userId: uid,
    name: 'Ada Lovelace',
    normalizedName: 'ada lovelace',
    kind: 'person',
  });
  await EntityEdge.create({
    userId: uid,
    fromEntityId: entity._id,
    toEntityId: entity._id,
    kind: 'related-to',
    summary: 'self-reference fixture',
  });
  const mcpServer = await McpServer.create({
    scope: 'user',
    userId: uid,
    name: 'remote-tools',
    url: `https://${uid}.example.com/sse`,
    headers: { iv: 'iv', tag: 'tag', ciphertext: 'cipher' },
    headersConfigured: true,
  });
  return { asset, mcpServer };
};

describe('purgeAllUserData (issue #143: factory reset)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsConfigured.mockReturnValue(false);
    mockedTracePurge.mockResolvedValue(undefined);
  });
  it('hard-deletes the user’s sessions — nothing survives, soft-deleted included', async () => {
    const uid = userId();
    await Session.create({ userId: uid, title: 'active' });
    await Session.create({ userId: uid, title: 'recoverable-unlisted', deletedAt: new Date() });

    await purgeAllUserData(uid);

    expect(await Session.countDocuments({ userId: uid })).toBe(0);
  });

  it('sweeps every enumerated collection to zero for the purging user; user B is untouched', async () => {
    const owner = userId();
    const other = userId();
    // A platform server is ownerless and must never be swept by any user's reset.
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://p.example.com',
    });
    await seedUserWorkspace(owner);
    await seedUserWorkspace(other);
    await seedAssetsAndGraph(owner);
    const otherAsset = await seedAssetsAndGraph(other);
    mockedIsConfigured.mockReturnValue(true);
    mockedDeleteByKey.mockResolvedValue(true);
    mockedListKeys.mockResolvedValue([]);

    await purgeAllUserData(owner);

    // Owner: every enumerated collection empty.
    expect(await Session.countDocuments({ userId: owner })).toBe(0);
    expect(await Message.countDocuments()).toBe(4); // only user B's remain
    expect(await Asset.countDocuments({ userId: owner })).toBe(0);
    // AssetJob has no userId: swept by the owner's asset ids only.
    expect(await AssetJob.countDocuments({ assetId: otherAsset.asset._id })).toBe(1);
    expect(await Entity.countDocuments({ userId: owner })).toBe(0);
    expect(await EntityEdge.countDocuments({ userId: owner })).toBe(0);
    // User-scoped MCP server configs (urls + encrypted auth headers) die too.
    expect(await McpServer.countDocuments({ scope: 'user', userId: owner })).toBe(0);
    // The ownerless platform server is untouched.
    expect(await McpServer.countDocuments({ scope: 'platform' })).toBe(1);

    // Other user: nothing changed.
    const otherSessions = await Session.find({ userId: other }).lean();
    expect(otherSessions).toHaveLength(2);
    expect(await Message.countDocuments({ sessionId: otherSessions[0]._id })).toBe(2);
    expect(await Asset.countDocuments({ userId: other })).toBe(1);
    expect(await Entity.countDocuments({ userId: other })).toBe(1);
    expect(await EntityEdge.countDocuments({ userId: other })).toBe(1);
  });

  it('fires the trace purge with the user’s session ids (read before deletion)', async () => {
    const traceIds: string[][] = [];
    mockedTracePurge.mockImplementation(async (ids: string[]) => {
      traceIds.push(ids);
    });
    const uid = userId();
    const session = await Session.create({ userId: uid, title: 'traced' });
    await Message.create([{ sessionId: session._id, role: 'user', content: 'q' }]);
    mockedIsConfigured.mockReturnValue(false);
    const sessionIds = await Session.find({ userId: uid }).select('_id').lean();
    void sessionIds;
    void session;

    await purgeAllUserData(uid);

    expect(traceIds).toEqual([[String(session._id)]]);
  });

  it('even when the trace purge throws, the Mongo data is still gone', async () => {
    const uid = userId();
    await seedUserWorkspace(uid);
    mockedIsConfigured.mockReturnValue(false);
    mockedTracePurge.mockRejectedValue(new Error('trace layer on fire'));

    await expect(purgeAllUserData(uid)).resolves.toEqual({ failedObjects: [] });
    expect(await Session.countDocuments({ userId: uid })).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('deletes Spaces asset objects and sweeps each chat file prefix by key', async () => {
    const uid = userId();
    const session = await Session.create({ userId: uid, title: 'with files' });
    await seedAssetsAndGraph(uid);
    mockedIsConfigured.mockReturnValue(true);
    mockedListKeys
      .mockResolvedValueOnce([`${uid}/chats/${session._id}/script.txt`])
      .mockResolvedValue([]);
    mockedDeleteByKey.mockResolvedValue(true);

    mockedListKeys
      .mockResolvedValueOnce([`${uid}/chats/${session._id}/script.txt`])
      .mockResolvedValue([]);
    mockedDeleteByKey.mockResolvedValue(true);

    await purgeAllUserData(uid);

    expect(mockedDeleteByKey).toHaveBeenCalledWith(`${uid}/asset-1/notes.md`);
    expect(mockedDeleteByKey).toHaveBeenCalledWith(`${uid}/chats/${session._id}/script.txt`);
  });

  it('reports nothing failed when Spaces is unconfigured (no bucket ever held the keys)', async () => {
    const uid = userId();
    await Session.create({ userId: uid, title: 'with files' });
    await seedAssetsAndGraph(uid);
    mockedIsConfigured.mockReturnValue(false);

    // Storage never configured → no bucket could hold the user's files, so
    // surface no failedObjects: a spurious warning would tell the user that
    // data remains when it cannot.
    await expect(purgeAllUserData(uid)).resolves.toEqual({ failedObjects: [] });
    expect(mockedDeleteByKey).not.toHaveBeenCalled();
    expect(mockedListKeys).not.toHaveBeenCalled();
  });

  it('reports a sentinel key when the workspace file sweep fails wholesale', async () => {
    const uid = userId();
    await Session.create({ userId: uid, title: 'with files' });
    await seedAssetsAndGraph(uid);
    mockedIsConfigured.mockReturnValue(true);
    mockedDeleteByKey.mockResolvedValue(true);
    // mockReset drops the previous test's queued `Once` implementations.
    mockedListKeys.mockReset().mockRejectedValue(new Error('S3 unavailable'));

    const result = await purgeAllUserData(uid);

    expect(result.failedObjects).toEqual([`${uid}/chats/*`]);
    expect(await Session.countDocuments({ userId: uid })).toBe(0);
  });
});
