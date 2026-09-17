import express from 'express';
import archiver from 'archiver';
import { isValidObjectId } from 'mongoose';
import { Asset, type AssetDocument } from '../models/Asset';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  assetBulkDeleteQuerySchema,
  assetBulkDownloadQuerySchema,
  assetPresignSchema,
} from '../validation';
import {
  deleteObject,
  getObjectBuffer,
  getObjectStream,
  headObject,
  isStorageConfigured,
  presignGetUrl,
  presignPutUrl,
} from '../services/storageService';
import { extractText, isExtractable, truncateForPrompt } from '../services/textExtraction';

const router = express.Router();

const MAX_ASSET_SIZE = 15 * 1024 * 1024;

// Allowlist enforced at presign time; the browser PUTs with this same
// Content-Type because the presigned URL stores it (Spaces rejects a PUT
// whose Content-Type doesn't match the signature).
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// Presign + confirm headroom: pending assets older than this cannot be
// confirmed, so stale rows never revive (plan honest-boundaries for #34).
const CONFIRM_MAX_AGE_MS = 60 * 60 * 1000;

// Extraction stays light: only objects up to this size are pulled back.
const MAX_EXTRACT_BYTES = 1_000_000;

const LIST_PAGE_SIZE = 20;

// Bulk zip limits (#69): file count comes from the query schema cap; the
// stored-size cap is the real limiter given the 15 MB per-file presign cap.
const BULK_MAX_TOTAL_SIZE = 500 * 1024 * 1024;

// Bulk-download entry names come from stored Asset.filename (sanitized at
// presign), with a defensive second pass here. Collisions get `name (2).ext`.
const sanitizeZipEntryName = (filename: string): string => {
  const cleaned = filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
  return cleaned || 'unnamed.bin';
};

const dedupeEntryNames = (filenames: string[]): string[] => {
  const counts = new Map<string, number>();
  return filenames.map((filename) => {
    const name = sanitizeZipEntryName(filename);
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    if (seen === 0) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base} (${seen + 1})${ext}`;
  });
};

// Filenames become the last path segment of the object key: no path
// separators, control chars or whitespace-only names.
const sanitizeFilename = (filename: string): string =>
  filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();

const safeAsset = (asset: AssetDocument): unknown => ({
  id: String(asset._id),
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  status: asset.status,
  // lets the UI tell the user when no text could be extracted (issue #34
  // owner ask) — the extracted text itself stays server-side, never a
  // client-rendered payload.
  hasText: Boolean(asset.textExtracted),
  createdAt: asset.createdAt,
});

const ownedAsset = async (req: AuthRequest): Promise<AssetDocument | null> => {
  const asset = await Asset.findOne({
    _id: req.params.id,
    userId: req.user?.id,
  });
  return asset;
};

// POST /api/assets/presign — mints the upload URL; no bytes reach Express.
router.post('/presign', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!isStorageConfigured()) {
      return res.status(503).json({ message: 'File storage is not configured' });
    }
    const parsed = assetPresignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.issues[0]?.message ?? 'Invalid upload request',
      });
    }
    const { filename, contentType, size } = parsed.data;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({ message: 'File type is not allowed' });
    }
    if (size > MAX_ASSET_SIZE) {
      return res.status(413).json({ message: 'File is too large (max 15 MB)' });
    }

    const userId = req.user?.id as string;
    const asset = await Asset.create({
      userId,
      filename: sanitizeFilename(filename),
      key: 'pending',
      contentType,
      size,
      status: 'pending',
    });

    const key = `${userId}/${asset._id}/${sanitizeFilename(filename)}`;
    asset.key = key;
    await asset.save();

    const uploadUrl = await presignPutUrl(key, 60, contentType);
    return res.status(201).json({ uploadUrl, asset: safeAsset(asset) });
  } catch (err) {
    console.error('Asset presign error:', err);
    return res.status(500).json({ message: 'Error preparing upload' });
  }
});

// POST /api/assets/:id/confirm — browser has PUT the object directly to
// Spaces; verify it really exists at the expected size, extract light text,
// and mark it ready. Net object checks run against the real Space so a
// lying client cannot mark an asset ready.
router.post('/:id/confirm', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    if (asset.status !== 'pending') {
      return res.status(409).json({ message: 'Asset was already confirmed' });
    }
    if (Date.now() - new Date(asset.createdAt).getTime() > CONFIRM_MAX_AGE_MS) {
      asset.status = 'failed';
      asset.failureReason = 'expired';
      await asset.save();
      return res.status(409).json({ message: 'Upload window has expired' });
    }

    let head;
    try {
      head = await headObject(asset.key);
    } catch (err) {
      console.error('Asset confirm HEAD error:', err);
      asset.status = 'failed';
      asset.failureReason = 'upload-not-found';
      await asset.save();
      return res.status(409).json({ message: 'Upload was not found in storage' });
    }

    if (head.size <= 0 || head.size > MAX_ASSET_SIZE) {
      asset.status = 'failed';
      asset.failureReason = 'size';
      await asset.save();
      return res.status(413).json({ message: 'Stored file size is invalid' });
    }

    asset.size = head.size;
    if (head.contentType) asset.contentType = head.contentType;

    let text: string | null = null;
    if (isExtractable(asset.filename) && head.size <= MAX_EXTRACT_BYTES) {
      const buf = await getObjectBuffer(asset.key);
      if (buf) text = truncateForPrompt(extractText(asset.filename, buf) ?? '');
      if (text !== null) asset.textExtracted = text === '' ? null : text;
    }

    asset.status = 'ready';
    await asset.save();
    return res.json({ asset: safeAsset(asset) });
  } catch (err) {
    console.error('Asset confirm error:', err);
    return res.status(500).json({ message: 'Error confirming upload' });
  }
});

// GET /api/assets — cursor-paged, strictly scoped to the caller.
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const query: Record<string, unknown> = { userId };
    const cursor = req.query.cursor;
    if (typeof cursor === 'string' && isValidObjectId(cursor)) {
      query._id = { $lt: cursor };
    }
    const assets = await Asset.find(query)
      .sort({ _id: -1 })
      .limit(LIST_PAGE_SIZE + 1);

    const hasMore = assets.length > LIST_PAGE_SIZE;
    const page = hasMore ? assets.slice(0, LIST_PAGE_SIZE) : assets;
    return res.json({
      assets: page.map(safeAsset),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    });
  } catch (err) {
    console.error('Asset list error:', err);
    return res.status(500).json({ message: 'Error listing assets' });
  }
});

// GET /api/assets/bulk-download — server-generated zip of owned assets
// (issue #69). Streams each stored object from Spaces into `archiver` —
// never buffered in memory. NOTE: any future generic `GET /:id` route must
// be registered *after* this one so `bulk-download` is not swallowed.
router.get('/bulk-download', authenticate, async (req: AuthRequest, res) => {
  const ids = req.query.id;
  const parsed = assetBulkDownloadQuerySchema.safeParse({ id: ids });
  if (!parsed.success) {
    return res.status(400).json({
      message: parsed.error.issues[0]?.message ?? 'Invalid bulk download request',
    });
  }

  try {
    const requested = parsed.data.id.filter((id) => isValidObjectId(id));
    // Every id malformed would otherwise leave an id-less find — a whole-
    // library download that bypasses the 50-id cap — so refuse instead.
    if (requested.length === 0) {
      return res.status(400).json({ message: 'No valid asset ids in selection' });
    }
    const assets = await Asset.find({
      _id: { $in: requested },
      userId: req.user?.id,
      status: 'ready',
    })
      .select('filename key size')
      .lean();

    if (assets.length === 0) {
      return res.status(400).json({ message: 'No downloadable assets in selection' });
    }
    const totalSize = assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
    if (totalSize > BULK_MAX_TOTAL_SIZE) {
      return res.status(413).json({ message: 'Selected assets exceed the 500 MB archive limit' });
    }

    const entryNames = dedupeEntryNames(assets.map((asset) => asset.filename));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err: archiver.ArchiverError) => console.error('Archive warning:', err));

    // Headers are not written until the first byte of zip data flushes; the
    // first streamed object is therefore fetched before any header, so a
    // storage failure on the very first asset can still return clean JSON.
    let started = false;
    const startResponse = () => {
      if (started) return;
      started = true;
      archive.on('error', (err: archiver.ArchiverError) => {
        console.error('Archive error:', err);
        res.destroy();
      });
      // Client gave up / connection dropped: stop feeding the zip.
      res.on('close', () => archive.abort());
      res.type('application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="assets-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.zip"`,
      );
      archive.pipe(res);
    };

    for (let i = 0; i < assets.length; i += 1) {
      const asset = assets[i]!;
      try {
        const body = await getObjectStream(asset.key);
        if (!body) {
          startResponse();
          archive.append('', { name: `${entryNames[i]}.missing` });
          continue;
        }
        startResponse();
        archive.append(body, { name: entryNames[i]! });
      } catch (err) {
        console.error('Asset bulk download stream error:', err);
        archive.abort();
        if (started && res.headersSent) {
          // Mid-stream: browsers will see a truncated zip (accepted
          // limitation — see #69 plan, OQ4).
          res.destroy();
          return;
        }
        return res.status(502).json({ message: 'Error retrieving assets from storage' });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('Asset bulk download error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Error building download archive' });
    }
    // Headers already sent mid-stream: browsers will see a truncated zip.
    res.destroy();
  }
});

// GET /api/assets/:id/url — short-expiry presigned GET; objects stay private.
router.get('/:id/url', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    if (asset.status !== 'ready') {
      return res.status(409).json({ message: 'Asset is not ready for download' });
    }
    const url = await presignGetUrl(asset.key, 300);
    return res.json({ url });
  } catch (err) {
    console.error('Asset url error:', err);
    return res.status(500).json({ message: 'Error signing download URL' });
  }
});

// DELETE /api/assets/bulk-delete — batch delete of owned assets with the
// same repeated `?id=` contract as bulk download. Objects are removed before
// the docs (mirroring the single delete); any storage failure aborts with a
// 502 and no doc deletion, so the operation either converges or can be
// retried cleanly.
router.delete('/bulk-delete', authenticate, async (req: AuthRequest, res) => {
  const ids = req.query.id;
  const parsed = assetBulkDeleteQuerySchema.safeParse({ id: ids });
  if (!parsed.success) {
    return res.status(400).json({
      message: parsed.error.issues[0]?.message ?? 'Invalid bulk delete request',
    });
  }

  try {
    const requested = parsed.data.id.filter((id) => isValidObjectId(id));
    if (requested.length === 0) {
      return res.status(400).json({ message: 'No valid asset ids in selection' });
    }
    const assets = await Asset.find({
      _id: { $in: requested },
      userId: req.user?.id,
    });
    if (assets.length === 0) {
      return res.status(404).json({ message: 'Asset not found' });
    }

    for (const asset of assets) {
      try {
        await deleteObject(asset.key);
      } catch (err) {
        console.error('Asset bulk delete object error:', err);
        return res.status(502).json({ message: 'Error deleting from storage' });
      }
    }
    const result = await Asset.deleteMany({ _id: { $in: assets.map((a) => a._id) } });
    if (result.deletedCount === 0) {
      return res.status(500).json({ message: 'Error deleting assets' });
    }
    return res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('Asset bulk delete error:', err);
    return res.status(500).json({ message: 'Error deleting assets' });
  }
});

// DELETE /api/assets/:id — object first, then the doc; a missing object is
// still a successful delete so the operation converges.
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    try {
      await deleteObject(asset.key);
    } catch (err) {
      console.error('Asset object delete error:', err);
      return res.status(502).json({ message: 'Error deleting from storage' });
    }
    const deleted = await Asset.findByIdAndDelete(asset._id);
    if (!deleted) {
      return res.status(500).json({ message: 'Error deleting asset' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Asset delete error:', err);
    return res.status(500).json({ message: 'Error deleting asset' });
  }
});

export default router;
