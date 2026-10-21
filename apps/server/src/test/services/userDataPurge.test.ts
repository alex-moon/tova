import mongoose from 'mongoose';
import { Session } from '../../main/models/Session';
import { Message } from '../../main/models/Message';
import { Asset } from '../../main/models/Asset';
import { AssetJob } from '../../main/models/AssetJob';
import { WorkspaceEmbedding } from '../../main/models/WorkspaceEmbedding';
import { Connector } from '../../main/models/Connector';
import { encryptEnvelope, MCP_ENCRYPTION_KEY_ENV_VAR } from '../../main/services/connectors/crypto';
import { purgeAllUserData } from '../../main/services/userDataPurge';
import { embedTexts } from '../../main/services/workspace/embeddingService';
import { enqueueWorkspaceEmbedding } from '../../main/services/workspace/workspaceEmbeddingIngest';

// Data-level purge coverage: storage and trace purge are mocked at the seam.
// @see #143
jest.mock('../../main/services/storageService', () => ({
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

jest.mock('../../main/services/trace/tracePurge', () => ({
  purgeUserTraces: jest.fn(),
}));

jest.mock('../../main/services/workspace/embeddingService');

// Tests are exempt from the storage-boundary import rule (eslint.config.js).
import { spacesWorkspaceStorage } from '../../main/services/workspace/workspaceStorage';
import { listObjectKeys } from '../../main/services/storageService';
import { purgeUserTraces } from '../../main/services/trace/tracePurge';

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

const seedAssetsAndMcp = async (uid: mongoose.Types.ObjectId) => {
  const asset = await Asset.create({
    userId: uid,
    filename: 'notes.md',
    key: `${uid}/asset-1/notes.md`,
    contentType: 'text/markdown',
    size: 10,
    status: 'ready',
  });
  await AssetJob.create({ assetId: asset._id });
  const connector = await Connector.create({
    scope: 'user',
    userId: uid,
    name: 'remote-tools',
    url: `https://${uid}.example.com/sse`,
    headers: { iv: 'iv', tag: 'tag', ciphertext: 'cipher' },
    headersConfigured: true,
  });
  return { asset, connector };
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
    // A platform server is ownerless and must never be swept by a user reset.
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://p.example.com',
    });
    await seedUserWorkspace(owner);
    await seedUserWorkspace(other);
    await seedAssetsAndMcp(owner);
    const otherAsset = await seedAssetsAndMcp(other);
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
    // User-scoped connector configs (urls + encrypted auth headers) die too.
    expect(await Connector.countDocuments({ scope: 'user', userId: owner })).toBe(0);
    // The ownerless platform server is untouched.
    expect(await Connector.countDocuments({ scope: 'platform' })).toBe(1);

    // Other user: nothing changed.
    const otherSessions = await Session.find({ userId: other }).lean();
    expect(otherSessions).toHaveLength(2);
    expect(await Message.countDocuments({ sessionId: otherSessions[0]._id })).toBe(2);
    expect(await Asset.countDocuments({ userId: other })).toBe(1);
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
    await seedAssetsAndMcp(uid);
    mockedIsConfigured.mockReturnValue(true);
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
    await seedAssetsAndMcp(uid);
    mockedIsConfigured.mockReturnValue(false);

    // Storage never configured: no bucket held files, so no failedObjects.
    await expect(purgeAllUserData(uid)).resolves.toEqual({ failedObjects: [] });
    expect(mockedDeleteByKey).not.toHaveBeenCalled();
    expect(mockedListKeys).not.toHaveBeenCalled();
  });

  it('reports a sentinel key when the workspace file sweep fails wholesale', async () => {
    const uid = userId();
    await Session.create({ userId: uid, title: 'with files' });
    await seedAssetsAndMcp(uid);
    mockedIsConfigured.mockReturnValue(true);
    mockedDeleteByKey.mockResolvedValue(true);
    // mockReset drops the previous test's queued `Once` implementations.
    mockedListKeys.mockReset().mockRejectedValue(new Error('S3 unavailable'));

    const result = await purgeAllUserData(uid);

    expect(result.failedObjects).toEqual([`${uid}/chats/*`]);
    expect(await Session.countDocuments({ userId: uid })).toBe(0);
  });

  it('sweeps the workspace embeddings; another user keeps theirs (#393)', async () => {
    const owner = userId();
    const other = userId();
    await WorkspaceEmbedding.create({
      userId: owner,
      kind: 'chat',
      sourceId: 'own-1',
      model: 'm',
      dim: 3,
      vector: [0.1, 0.2, 0.3],
      textHash: 'h1',
    });
    await WorkspaceEmbedding.create({
      userId: other,
      kind: 'chat',
      sourceId: 'other-1',
      model: 'm',
      dim: 3,
      vector: [0.4, 0.5, 0.6],
      textHash: 'h2',
    });

    await purgeAllUserData(owner);

    // Content-derived vectors are PII-bearing and die with the account data.
    expect(await WorkspaceEmbedding.countDocuments({ userId: owner })).toBe(0);
    expect(await WorkspaceEmbedding.countDocuments({ userId: other })).toBe(1);
  });

  it('drains an in-flight embed around the sweep so no vector re-inserts (#393)', async () => {
    const owner = userId();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(embedTexts).mockImplementation(() => gate.then(() => [[0.1]]));
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    enqueueWorkspaceEmbedding({
      userId: String(owner),
      kind: 'chat',
      sourceId: 'race-1',
      source: { kind: 'chat', content: 'leak me after the reset' },
    });

    try {
      const purgePromise = purgeAllUserData(owner);
      // Handler from the start: an early rejection must not surface unhandled.
      purgePromise.catch(() => undefined);
      // Pre-reads settle well within this wait; the purge then blocks in the
      // drain on the still-closed gate.
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await purgePromise;
      // The drained embed wrote its row, then the sweep wiped it — without
      // the drain, this upsert would land after the sweep and survive.
      expect(await WorkspaceEmbedding.countDocuments({ userId: owner })).toBe(0);
    } finally {
      release();
      delete process.env.WORKSPACE_MEMORY_ENABLED;
    }
  });
});

describe('RFC 7009 grant revocation on factory reset (#333 wash-up)', () => {
  beforeAll(() => {
    process.env[MCP_ENCRYPTION_KEY_ENV_VAR] = 'purge-oauth-test-key';
  });

  const createVaulted = (owner: mongoose.Types.ObjectId, vault: Record<string, unknown>) =>
    Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: owner,
      name: 'vaulted',
      url: 'https://mcp.example.com/mcp',
      oauth: encryptEnvelope(JSON.stringify(vault)),
    });

  it('posts the refresh token to the advertised revocation endpoint, then sweeps the row', async () => {
    const owner = userId();
    await createVaulted(owner, {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      metadata: { revocation_endpoint: 'https://as.example.com/revoke' },
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      await purgeAllUserData(owner);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://as.example.com/revoke');
      expect(init?.method).toBe('POST');
      expect((init?.body as URLSearchParams).get('token')).toBe('rt-1');
      // The grant dies at the provider AND the row (with its vault) dies here.
      expect(await Connector.countDocuments({ scope: 'user', userId: owner })).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('skips revocation when the AS advertises no revocation endpoint', async () => {
    const owner = userId();
    await createVaulted(owner, { accessToken: 'at-2', refreshToken: 'rt-2' });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      await purgeAllUserData(owner);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await Connector.countDocuments({ scope: 'user', userId: owner })).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses to POST the bearer token to a non-https revocation endpoint (#397 SSRF)', async () => {
    const owner = userId();
    await createVaulted(owner, {
      accessToken: 'at-3',
      refreshToken: 'rt-3',
      metadata: { revocation_endpoint: 'http://169.254.169.254/revoke' },
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      await purgeAllUserData(owner);
      expect(fetchSpy).not.toHaveBeenCalled();
      // The row still dies: revocation is best-effort, erasure is not.
      expect(await Connector.countDocuments({ scope: 'user', userId: owner })).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
