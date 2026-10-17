import { RequestContext } from '@mastra/core/request-context';
import { User } from '../../main/models/User';
import { Asset } from '../../main/models/Asset';
import { AssetVersion } from '../../main/models/AssetVersion';
import { generateFileTool, readFileTool, editFileTool } from '../../main/services/mastraService';
import { pruneOldAssetVersions } from '../../main/services/assetVersionPrune';

jest.mock('../../main/services/workspaceStorage', () => ({
  spacesWorkspaceStorage: {
    isConfigured: () => true,
    putByKey: jest.fn().mockResolvedValue(undefined),
  },
}));

/* Tool-level tests for #369: filename resolution on read/edit, and duplicate generated filenames versioning the same row instead of duplicating it. */
// @see #369

const asCtx = (userId?: string, sessionId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  if (sessionId) requestContext.set('sessionId', sessionId);
  return { requestContext };
};

const executeTool = <A, R>(tool: { execute?: unknown }) =>
  (tool as { execute: (args: A, ctx: unknown) => Promise<R> }).execute;

const generate = executeTool<
  { filename: string; content: string },
  { file?: { id: string; filename: string; version?: number }; error?: string }
>(generateFileTool);

const read = executeTool<
  { id?: string; filename?: string },
  { file?: { id: string; filename: string }; content?: string; error?: string }
>(readFileTool);

const edit = executeTool<
  { id?: string; filename?: string; edits: { oldText: string; newText: string }[] },
  { file?: { id: string; version: number }; error?: string }
>(editFileTool);

const seedUser = (email = 'files@example.com') => User.create({ email, passwordHash: 'x' });

const seedAsset = (userId: string, filename: string, overrides: Record<string, unknown> = {}) =>
  Asset.create({
    userId,
    filename,
    key: `${userId}/x/${filename}`,
    contentType: 'text/markdown',
    size: 10,
    textExtracted: 'line one\nline two',
    status: 'ready',
    origin: 'system-generated',
    ...overrides,
  });

describe('read_file by filename (#369)', () => {
  it('resolves the newest ready row with the filename', async () => {
    const user = await seedUser();
    const old = await seedAsset(String(user._id), 'notes.md', { createdAt: oldDate() });
    await seedAsset(String(user._id), 'notes.md', { createdAt: new Date() });
    const result = await read({ filename: 'notes.md' }, asCtx(String(user._id)));
    expect(result.error).toBeUndefined();
    expect(result.file?.id).toEqual(expect.any(String));
    // Newest wins: the id differs from the older row.
    expect(result.file?.id).not.toBe(String(old._id));
    expect(result.content).toContain('line one');
  });

  it('sanitizes the provided filename the same way creation does', async () => {
    const user = await seedUser();
    await seedAsset(String(user._id), 'my_file.md');
    const result = await read({ filename: 'my/file.md' }, asCtx(String(user._id)));
    expect(result.error).toBeUndefined();
    expect(result.file?.filename).toBe('my_file.md');
  });

  it('still resolves by id and reports not_found when neither id nor filename matches', async () => {
    const user = await seedUser();
    const asset = await seedAsset(String(user._id), 'a.md');
    expect((await read({ id: String(asset._id) }, asCtx(String(user._id)))).file?.id).toBe(
      String(asset._id),
    );
    expect((await read({ filename: 'nope.md' }, asCtx(String(user._id)))).error).toBe('not_found');
    expect((await read({}, asCtx(String(user._id)))).error).toBe('not_found');
  });

  it('never reads another user’s row', async () => {
    const owner = await seedUser('files-owner@example.com');
    const other = await seedUser('files-other@example.com');
    await seedAsset(String(owner._id), 'mine.md');
    expect((await read({ filename: 'mine.md' }, asCtx(String(other._id)))).error).toBe('not_found');
  });
});

function oldDate(): Date {
  return new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
}

describe('edit_file by filename (#369)', () => {
  it('applies the edit to the row resolved from the filename and bumps the version', async () => {
    const user = await seedUser();
    const asset = await seedAsset(String(user._id), 'draft.md');
    const result = await edit(
      { filename: 'draft.md', edits: [{ oldText: 'line one', newText: 'LINE ONE' }] },
      asCtx(String(user._id)),
    );
    expect(result.error).toBeUndefined();
    expect(result.file?.id).toBe(String(asset._id));
    expect(result.file?.version).toBe(2);
    const fresh = await Asset.findById(asset._id);
    expect(fresh?.textExtracted).toBe('LINE ONE\nline two');
  });

  it('keeps the not_editable rule for non-generated rows resolved by filename', async () => {
    const user = await seedUser();
    await seedAsset(String(user._id), 'upload.md', { origin: 'user-upload' });
    const result = await edit(
      { filename: 'upload.md', edits: [{ oldText: 'line one', newText: 'x' }] },
      asCtx(String(user._id)),
    );
    expect(result.error).toBe('not_editable');
  });
});

describe('generate_file duplicate filename (#369)', () => {
  it('supersedes an existing generated file as a new version instead of a duplicate row', async () => {
    const user = await seedUser();
    const original = await seedAsset(String(user._id), 'report.md');
    const result = await generate(
      { filename: 'report.md', content: 'v2 content' },
      asCtx(String(user._id), 'sess-1'),
    );
    expect(result.error).toBeUndefined();
    expect(result.file?.id).toBe(String(original._id));
    expect(result.file?.version).toBe(2);
    expect(await Asset.countDocuments({ userId: user._id, filename: 'report.md' })).toBe(1);
    const fresh = await Asset.findById(original._id);
    expect(fresh?.textExtracted).toBe('v2 content');
    // Both versions snapshotted; the agent sees only the row (the latest).
    expect(await AssetVersion.countDocuments({ assetId: original._id })).toBe(2);
  });

  it('does not fold a generated file into a user upload with the same name', async () => {
    const user = await seedUser();
    await seedAsset(String(user._id), 'same-name.md', { origin: 'user-upload' });
    const result = await generate(
      { filename: 'same-name.md', content: 'agent version' },
      asCtx(String(user._id)),
    );
    expect(result.error).toBeUndefined();
    expect(result.file?.version).toBeUndefined();
    expect(await Asset.countDocuments({ userId: user._id, filename: 'same-name.md' })).toBe(2);
  });
});

describe('pruneOldAssetVersions (#369)', () => {
  it('deletes superseded versions older than a year and keeps the newest and fresh ones', async () => {
    const user = await seedUser();
    const asset = await seedAsset(String(user._id), 'prune.md');
    const yearAgo = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
    await AssetVersion.create([
      {
        assetId: asset._id,
        userId: user._id,
        version: 1,
        filename: 'prune.md',
        size: 1,
        textExtracted: 'a',
        createdAt: yearAgo,
        updatedAt: yearAgo,
      },
      {
        assetId: asset._id,
        userId: user._id,
        version: 2,
        filename: 'prune.md',
        size: 1,
        textExtracted: 'b',
        createdAt: yearAgo,
        updatedAt: yearAgo,
      },
      {
        assetId: asset._id,
        userId: user._id,
        version: 3,
        filename: 'prune.md',
        size: 1,
        textExtracted: 'c',
      },
    ]);
    const deleted = await pruneOldAssetVersions();
    expect(deleted).toBe(1);
    const remaining = await AssetVersion.find({ assetId: asset._id }).sort({ version: 1 });
    expect(remaining.map((r) => r.version)).toEqual([2, 3]);
  });

  it('keeps an old version when it is the latest for its asset', async () => {
    const user = await seedUser();
    const asset = await seedAsset(String(user._id), 'stale.md');
    const yearAgo = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
    await AssetVersion.create({
      assetId: asset._id,
      userId: user._id,
      version: 1,
      filename: 'stale.md',
      size: 1,
      textExtracted: 'a',
      createdAt: yearAgo,
      updatedAt: yearAgo,
    });
    expect(await pruneOldAssetVersions()).toBe(0);
    expect(await AssetVersion.countDocuments({ assetId: asset._id })).toBe(1);
  });
});
