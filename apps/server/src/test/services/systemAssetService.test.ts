import { Asset } from '../../main/models/Asset';
import mongoose from 'mongoose';
import {
  createSystemAsset,
  createSystemSideAsset,
  findFreshScrape,
} from '../../main/services/systemAssetService';
import { sanitizeFilename } from '../../main/services/assetLimits';
import { MAX_MARKDOWN_CHARS } from '../../main/services/markdownConversion';

jest.mock('../../main/services/storageService', () => ({
  putObject: jest.fn(),
}));

const mockPutObject = jest.requireMock('../../main/services/storageService').putObject as jest.Mock;

const VALID = Buffer.from('# hello\n\nworld');
const oid = (): string => new mongoose.Types.ObjectId().toString();

describe('createSystemAsset (#66)', () => {
  beforeEach(() => {
    mockPutObject.mockReset();
  });

  describe('validation', () => {
    it('rejects non-markdown content types before touching Mongo or Spaces', async () => {
      expect(await createSystemAsset(oid(), 'notes.txt', VALID, 'text/plain')).toEqual({
        ok: false,
        code: 'invalid',
        message: expect.stringContaining('not allowed'),
      });
      expect(await Asset.countDocuments()).toBe(0);
      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it('rejects empty buffers', async () => {
      expect(await createSystemAsset(oid(), 'notes.md', Buffer.alloc(0), 'text/markdown')).toEqual({
        ok: false,
        code: 'invalid',
        message: expect.stringContaining('empty'),
      });
    });

    it('rejects buffers over MAX_ASSET_SIZE', async () => {
      const big = Buffer.alloc(15 * 1024 * 1024 + 1, 0x61);
      expect(await createSystemAsset(oid(), 'notes.md', big, 'text/markdown')).toEqual({
        ok: false,
        code: 'too_large',
        message: expect.stringContaining('too large'),
      });
      expect(await Asset.countDocuments()).toBe(0);
    });

    it('rejects filenames that sanitize to nothing', async () => {
      expect(await createSystemAsset(oid(), '   ', VALID, 'text/markdown')).toEqual({
        ok: false,
        code: 'invalid',
        message: expect.stringContaining('filename'),
      });
    });
  });

  describe('happy path', () => {
    it('creates a ready asset under the sanitized key with full text', async () => {
      mockPutObject.mockResolvedValue(undefined);
      const userId = oid();
      const result = await createSystemAsset(
        userId,
        '../../evil notes.md ',
        VALID,
        'text/markdown',
      );
      expect(result.ok).toBe(true);

      const asset = await Asset.findOne({ userId });
      expect(asset?.status).toBe('ready');
      expect(asset?.origin).toBe('system-generated');
      expect(asset?.filename).toBe('.._.._evil notes.md');
      expect(asset?.key).toBe(`${userId}/${asset?._id}/.._.._evil notes.md`);
      expect(asset?.contentType).toBe('text/markdown');
      expect(asset?.size).toBe(VALID.length);
      expect(asset?.textExtracted).toBe('# hello\n\nworld');
      expect(asset?.markdownStatus).toBe('none');
      expect(sanitizeFilename('../../evil notes.md ')).toBe('.._.._evil notes.md');

      expect(mockPutObject).toHaveBeenCalledWith(
        `${userId}/${asset?._id}/.._.._evil notes.md`,
        VALID,
        'text/markdown',
      );
    });

    it('writes provenance when one is passed (#252)', async () => {
      mockPutObject.mockResolvedValue(undefined);
      const userId = oid();
      const sessionId = oid();
      await createSystemAsset(userId, 'notes.md', VALID, 'text/markdown', {
        kind: 'chat',
        sessionId,
      });
      const asset = await Asset.findOne({ userId });
      expect(asset?.provenance?.kind).toBe('chat');
      expect(asset?.provenance?.sessionId).toBe(sessionId);
    });

    it('leaves provenance absent when omitted (#252)', async () => {
      mockPutObject.mockResolvedValue(undefined);
      const userId = oid();
      await createSystemAsset(userId, 'notes.md', VALID, 'text/markdown');
      const asset = await Asset.findOne({ userId });
      expect(asset?.provenance).toBeUndefined();
    });
  });

  describe('storage failure', () => {
    it('marks the asset failed with failureReason and rethrows', async () => {
      const userId = oid();
      mockPutObject.mockRejectedValue(new Error('Spaces down'));
      await expect(createSystemAsset(userId, 'notes.md', VALID, 'text/markdown')).rejects.toThrow(
        'Spaces down',
      );
      const asset = await Asset.findOne({ userId });
      expect(asset?.status).toBe('failed');
      expect(asset?.failureReason).toBe('storage-error');
    });
  });
});

describe('createSystemSideAsset (#340)', () => {
  const MARKDOWN = '# scraped page\n\nbody text';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ttlBackup = process.env.AGENT_ASSET_TTL_DAYS;

  beforeEach(() => {
    mockPutObject.mockReset();
  });

  afterEach(() => {
    if (ttlBackup === undefined) delete process.env.AGENT_ASSET_TTL_DAYS;
    else process.env.AGENT_ASSET_TTL_DAYS = ttlBackup;
  });

  it('creates a ready text-only row: origin system-side, no Spaces object', async () => {
    const userId = oid();
    const saved = await createSystemSideAsset(userId, 'web-example.com-page.md', MARKDOWN);
    expect(saved).toMatchObject({ filename: 'web-example.com-page.md' });

    const asset = await Asset.findOne({ userId });
    expect(asset?.status).toBe('ready');
    expect(asset?.origin).toBe('system-side');
    expect(asset?.textExtracted).toBe(MARKDOWN);
    expect(asset?.markdownStatus).toBe('none');
    expect(asset?.key).toBe(`agent-side/${String(asset?._id)}/web-example.com-page.md`);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('stamps expiresAt from the TTL config (default 30 days) for the native TTL index', async () => {
    const before = Date.now();
    await createSystemSideAsset(oid(), 'page.md', MARKDOWN);
    const asset = await Asset.findOne({ origin: 'system-side' });
    const actual = (asset?.expiresAt as Date).getTime();
    expect(actual).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(actual).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  it('omits expiresAt when the TTL is disabled (0 days) — TTL never fires', async () => {
    process.env.AGENT_ASSET_TTL_DAYS = '0';
    await createSystemSideAsset(oid(), 'page.md', MARKDOWN);
    const asset = await Asset.findOne({ origin: 'system-side' });
    expect(asset?.expiresAt).toBeUndefined();
  });

  it('records the source URL — the cache key for reuse over a re-scrape', async () => {
    await createSystemSideAsset(oid(), 'page.md', MARKDOWN, undefined, 'https://example.com/');
    const asset = await Asset.findOne({ origin: 'system-side' });
    expect(asset?.sourceUrl).toBe('https://example.com/');
  });

  it('returns null for blank markdown or a filename that sanitizes away', async () => {
    expect(await createSystemSideAsset(oid(), 'page.md', '   ')).toBeNull();
    expect(await createSystemSideAsset(oid(), '   ', MARKDOWN)).toBeNull();
    expect(await Asset.countDocuments({ origin: 'system-side' })).toBe(0);
  });
});

describe('findFreshScrape (#340)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MARKDOWN = '# scraped page\n\nbody text';
  const URL = 'https://example.com/';
  const ttlBackup = process.env.AGENT_ASSET_TTL_DAYS;

  beforeEach(() => {
    mockPutObject.mockReset();
  });

  afterEach(() => {
    if (ttlBackup === undefined) delete process.env.AGENT_ASSET_TTL_DAYS;
    else process.env.AGENT_ASSET_TTL_DAYS = ttlBackup;
  });

  it('returns the fresh copy for an exact URL match', async () => {
    const userId = oid();
    await createSystemSideAsset(userId, 'page.md', MARKDOWN, undefined, URL);
    expect(await findFreshScrape(userId, URL)).toMatchObject({
      fileId: expect.any(String),
      filename: 'page.md',
      content: MARKDOWN,
    });
  });

  it('misses a different URL or another user', async () => {
    const userId = oid();
    await createSystemSideAsset(userId, 'page.md', MARKDOWN, undefined, URL);
    expect(await findFreshScrape(userId, 'https://other.com/')).toBeNull();
    expect(await findFreshScrape(oid(), URL)).toBeNull();
  });

  it('misses a row past the staleness horizon — re-download territory', async () => {
    const userId = oid();
    await createSystemSideAsset(userId, 'page.md', MARKDOWN, undefined, URL);
    // Mongoose protects createdAt from updates; write raw to backdate it.
    await Asset.collection.updateOne(
      { userId: new mongoose.Types.ObjectId(userId) },
      { $set: { createdAt: new Date(Date.now() - 31 * DAY_MS) } },
    );
    expect(await findFreshScrape(userId, URL)).toBeNull();
  });

  it('reuses regardless of age when the TTL is disabled (0 = no expiry, #396)', async () => {
    process.env.AGENT_ASSET_TTL_DAYS = '0';
    const userId = oid();
    await createSystemSideAsset(userId, 'page.md', MARKDOWN, undefined, URL);
    await Asset.collection.updateOne(
      { userId: new mongoose.Types.ObjectId(userId) },
      { $set: { createdAt: new Date(Date.now() - 400 * DAY_MS) } },
    );
    expect(await findFreshScrape(userId, URL)).toMatchObject({ filename: 'page.md' });
  });

  it('caps agent-side markdown at the shared store cap (#396)', async () => {
    const huge = `${'# headline\n\nbody\n'.repeat(50_000)}tail-marker`;
    const saved = await createSystemSideAsset(oid(), 'huge.md', huge);
    expect(saved).not.toBeNull();
    const asset = await Asset.findOne({ origin: 'system-side', filename: 'huge.md' });
    expect(asset?.textExtracted?.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    expect(asset?.textExtracted).not.toContain('tail-marker');
  });
});
