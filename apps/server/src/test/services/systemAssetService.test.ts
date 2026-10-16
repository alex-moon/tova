import { Asset } from '../../main/models/Asset';
import mongoose from 'mongoose';
import { createSystemAsset } from '../../main/services/systemAssetService';
import { sanitizeFilename } from '../../main/services/assetLimits';

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
