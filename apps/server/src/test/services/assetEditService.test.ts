import mongoose from 'mongoose';
import { Asset } from '../../main/models/Asset';
import { AssetVersion } from '../../main/models/AssetVersion';
import { isStorageConfigured } from '../../main/services/storageService';
import {
  applyAssetEdits,
  applyEditsToContent,
  restoreAssetVersion,
  writeAssetContent,
} from '../../main/services/assetEditService';

const mockPutObject = jest.fn();
const mockEnqueueEmbedding = jest.fn();

jest.mock('../../main/services/storageService', () => ({
  isStorageConfigured: jest.fn().mockReturnValue(true),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

jest.mock('../../main/services/workspaceEmbeddingIngest', () => ({
  enqueueWorkspaceEmbedding: (...args: unknown[]) => mockEnqueueEmbedding(...args),
}));

const oid = (): string => new mongoose.Types.ObjectId().toString();

const createGenerated = async (content = '# draft\n\nbody') => {
  const userId = oid();
  const id = new mongoose.Types.ObjectId();
  await Asset.create({
    _id: id,
    userId,
    filename: 'notes.md',
    key: `${userId}/${String(id)}/notes.md`,
    contentType: 'text/markdown',
    size: Buffer.byteLength(content, 'utf8'),
    status: 'ready',
    origin: 'system-generated',
    textExtracted: content,
  });
  return Asset.findById(id).then((a) => a!);
};

beforeEach(() => {
  mockPutObject.mockReset().mockResolvedValue(undefined);
  mockEnqueueEmbedding.mockReset();
  (isStorageConfigured as jest.Mock).mockReturnValue(true);
});

describe('applyEditsToContent (#325)', () => {
  it('replaces a unique block', () => {
    expect(applyEditsToContent('a\nb\nc', [{ oldText: 'b', newText: 'B' }])).toEqual({
      ok: true,
      content: 'a\nB\nc',
    });
  });

  it('applies edits sequentially against the running content', () => {
    const out = applyEditsToContent('one two three', [
      { oldText: 'one', newText: 'ONE' },
      { oldText: 'ONE two', newText: 'ONE-TWO' },
    ]);
    expect(out).toEqual({ ok: true, content: 'ONE-TWO three' });
  });

  it('allows deleting a block with an empty replacement', () => {
    expect(
      applyEditsToContent('keep\nremove me\n', [{ oldText: 'remove me\n', newText: '' }]),
    ).toEqual({ ok: true, content: 'keep\n' });
  });

  it('reports no_match with the failing edit index', () => {
    expect(
      applyEditsToContent('hello', [
        { oldText: 'hello', newText: 'hi' },
        { oldText: 'absent', newText: 'x' },
      ]),
    ).toEqual({ ok: false, code: 'no_match', index: 1 });
  });

  it('refuses an ambiguous match rather than editing the wrong occurrence', () => {
    expect(applyEditsToContent('x\nmid\ny\nmid', [{ oldText: 'mid', newText: 'M' }])).toEqual({
      ok: false,
      code: 'ambiguous',
      index: 0,
    });
  });

  it('reports no_change when an edit replaces text with itself', () => {
    expect(applyEditsToContent('abc', [{ oldText: 'abc', newText: 'abc' }])).toEqual({
      ok: false,
      code: 'no_change',
      index: 0,
    });
  });

  // Tolerance ladder: when there is no exact match, the matcher retries ignoring unicode variants, then per-line trailing whitespace.
  it('matches despite typographic quote and dash variants', () => {
    expect(
      applyEditsToContent('don’t worry — ok', [{ oldText: "don't worry - ok", newText: 'fine' }]),
    ).toEqual({ ok: true, content: 'fine' });
  });

  it('matches despite trailing whitespace on the quoted lines', () => {
    expect(
      applyEditsToContent('keep  \nnext line', [
        { oldText: 'keep\nnext line', newText: 'B\nnext line' },
      ]),
    ).toEqual({ ok: true, content: 'B\nnext line' });
  });

  it('preserves CRLF endings from the matched region', () => {
    expect(applyEditsToContent('a\r\nb\r\nc', [{ oldText: 'a\nb', newText: 'A\nB' }])).toEqual({
      ok: true,
      content: 'A\r\nB\r\nc',
    });
  });

  it('leaves line endings of untouched regions alone', () => {
    const content = 'first\r\n\r\nsecond\r\n';
    const out = applyEditsToContent(content, [{ oldText: 'second', newText: 'SECOND' }]);
    expect(out).toEqual({ ok: true, content: 'first\r\n\r\nSECOND\r\n' });
  });
});

describe('writeAssetContent (#325)', () => {
  it('refuses non assistant-generated assets', async () => {
    const userId = oid();
    const id = new mongoose.Types.ObjectId();
    await Asset.create({
      _id: id,
      userId,
      filename: 'upload.md',
      key: `${userId}/${String(id)}/upload.md`,
      contentType: 'text/markdown',
      size: 3,
      status: 'ready',
      origin: 'user-upload',
      textExtracted: 'abc',
    });
    const asset = (await Asset.findById(id))!;
    const result = await writeAssetContent(asset, 'xyz');
    expect(result).toMatchObject({ ok: false, code: 'not_editable' });
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized result before writing', async () => {
    const asset = await createGenerated();
    expect(await writeAssetContent(asset, '')).toMatchObject({ ok: false, code: 'invalid' });
    const huge = 'x'.repeat(15 * 1024 * 1024 + 1);
    expect(await writeAssetContent(asset, huge)).toMatchObject({ ok: false, code: 'too_large' });
    expect(mockPutObject).not.toHaveBeenCalled();
    expect((await Asset.findById(asset._id))?.version).toBe(1);
  });

  it('degrades to unavailable when storage is unconfigured', async () => {
    (isStorageConfigured as jest.Mock).mockReturnValue(false);
    const asset = await createGenerated();
    expect(await writeAssetContent(asset, 'next')).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
  });

  it('leaves state untouched when the Spaces write fails', async () => {
    const asset = await createGenerated('# draft');
    mockPutObject.mockRejectedValue(new Error('Spaces down'));
    expect(await writeAssetContent(asset, '# next')).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    const reloaded = (await Asset.findById(asset._id))!;
    expect(reloaded.textExtracted).toBe('# draft');
    expect(reloaded.version).toBe(1);
    expect(await AssetVersion.countDocuments({ assetId: asset._id })).toBe(0);
    expect(mockEnqueueEmbedding).not.toHaveBeenCalled();
  });
});

describe('applyAssetEdits (#325)', () => {
  it('writes the new content, bumps the version, snapshots both, and re-embeds', async () => {
    const asset = await createGenerated('# draft\n\nbody');
    const result = await applyAssetEdits(asset, [{ oldText: 'body', newText: 'body v2' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.asset.textExtracted).toBe('# draft\n\nbody v2');
    expect(result.asset.size).toBe(Buffer.byteLength('# draft\n\nbody v2', 'utf8'));
    expect(result.asset.version).toBe(2);

    // The object is overwritten at the unchanged key.
    expect(mockPutObject).toHaveBeenCalledWith(
      asset.key,
      Buffer.from('# draft\n\nbody v2', 'utf8'),
      'text/markdown',
    );

    const versions = await AssetVersion.find({ assetId: asset._id }).sort({ version: 1 }).lean();
    expect(versions.map((v) => [v.version, v.textExtracted])).toEqual([
      [1, '# draft\n\nbody'],
      [2, '# draft\n\nbody v2'],
    ]);

    expect(mockEnqueueEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file', sourceId: String(asset._id) }),
    );
  });

  it('preserves the original provenance across an edit', async () => {
    const userId = oid();
    const sessionId = oid();
    const id = new mongoose.Types.ObjectId();
    await Asset.create({
      _id: id,
      userId,
      filename: 'notes.md',
      key: `${userId}/${String(id)}/notes.md`,
      contentType: 'text/markdown',
      size: 3,
      status: 'ready',
      origin: 'system-generated',
      textExtracted: 'abc',
      provenance: { kind: 'chat', sessionId },
    });
    const asset = (await Asset.findById(id))!;
    const result = await applyAssetEdits(asset, [{ oldText: 'abc', newText: 'abcd' }]);
    expect(result.ok).toBe(true);
    const reloaded = (await Asset.findById(id))!;
    expect(reloaded.provenance?.kind).toBe('chat');
    expect(reloaded.provenance?.sessionId).toBe(sessionId);
  });

  it('surfaces no_match without writing', async () => {
    const asset = await createGenerated('abc');
    const result = await applyAssetEdits(asset, [{ oldText: 'zzz', newText: 'y' }]);
    expect(result).toMatchObject({ ok: false, code: 'no_match' });
    expect(mockPutObject).not.toHaveBeenCalled();
    expect((await Asset.findById(asset._id))?.version).toBe(1);
  });

  it('surfaces no_change with a retry hint instead of writing', async () => {
    const asset = await createGenerated('abc');
    const result = await applyAssetEdits(asset, [{ oldText: 'abc', newText: 'abc' }]);
    expect(result).toMatchObject({ ok: false, code: 'no_change' });
    expect(mockPutObject).not.toHaveBeenCalled();
    expect((await Asset.findById(asset._id))?.version).toBe(1);
  });

  it('keeps one row per version across repeated edits', async () => {
    const asset = await createGenerated('a');
    await applyAssetEdits(asset, [{ oldText: 'a', newText: 'ab' }]);
    const second = await Asset.findById(asset._id);
    await applyAssetEdits(second!, [{ oldText: 'ab', newText: 'abc' }]);

    const versions = await AssetVersion.find({ assetId: asset._id }).sort({ version: 1 }).lean();
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await Asset.findById(asset._id))?.version).toBe(3);
  });
});

describe('restoreAssetVersion (#325)', () => {
  it('restores a prior version as a new version, keeping history', async () => {
    const asset = await createGenerated('v1 text');
    await applyAssetEdits(asset, [{ oldText: 'v1 text', newText: 'v2 text' }]);
    const current = (await Asset.findById(asset._id))!;

    const result = await restoreAssetVersion(current, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.textExtracted).toBe('v1 text');
    expect(result.asset.version).toBe(3);

    const versions = await AssetVersion.find({ assetId: asset._id }).sort({ version: 1 }).lean();
    expect(versions.map((v) => [v.version, v.textExtracted])).toEqual([
      [1, 'v1 text'],
      [2, 'v2 text'],
      [3, 'v1 text'],
    ]);
  });

  it('reports not_found for an unknown version', async () => {
    const asset = await createGenerated('only');
    expect(await restoreAssetVersion(asset, 9)).toMatchObject({ ok: false, code: 'not_found' });
    expect(mockPutObject).not.toHaveBeenCalled();
  });
});
