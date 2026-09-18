import express from 'express';
import archiver from 'archiver';
import { isValidObjectId } from 'mongoose';
import { Asset, type AssetDocument } from '../models/Asset';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  assetBulkConfirmSchema,
  assetBulkDeleteQuerySchema,
  assetBulkDownloadQuerySchema,
  assetBulkPresignSchema,
  assetPresignSchema,
  MAX_BULK_TOTAL_SIZE,
} from '../validation';
import {
  getObjectBuffer,
  getObjectStream,
  headObject,
  isStorageConfigured,
  presignGetUrl,
  presignPutUrl,
} from '../services/storageService';
import { extractText, isExtractable, truncateForPrompt } from '../services/textExtraction';
import { enqueueAssetJob } from '../services/assetJobService';
import { isConvertible } from '../services/markdownConversion';

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
  // Issue #67: convertible document formats reach the markdown pipeline.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
//   'application/zip' is deliberately absent: zip is never an accepted upload
//   format (issue #68 hard rule) — uploads are direct browser→Spaces PUTs of
//   single files, and no upload path ever reads archive contents.

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
  // Issue #83: markdown conversion output counts as text — align with the
  // chat read path (textExtracted ?? markdownExtracted) so library picks of
  // converted PDFs don't report a false "no text extracted".
  hasText: Boolean(asset.textExtracted ?? asset.markdownExtracted),
  // Issue #67: conversion lifecycle for the library UI badge; no markdown
  // text ever reaches the client.
  markdownStatus: asset.markdownStatus,
  // Issue #83: surface the worker's last failure reason for the failed-card
  // tooltip (metadata only — no markdown text content).
  markdownFailureReason: asset.markdownFailureReason ?? null,
  createdAt: asset.createdAt,
});

const ownedAsset = async (req: AuthRequest): Promise<AssetDocument | null> => {
  const asset = await Asset.findOne({
    _id: req.params.id,
    userId: req.user?.id,
  });
  return asset;
};

// Core of POST /presign (and, per #68, of the bulk presign per-item loop):
// policy checks (type allowlist, size cap), then mint a pending Asset row and
// presign its direct-to-Spaces PUT URL. Returns a typed rejection instead of
// throwing so bulk can map one bad file to a per-item row without blocking
// its siblings; the single route maps the same shape to a status code.
type PresignItem = { filename: string; contentType: string; size: number };
type PresignResult =
  | { status: 'ok'; uploadUrl: string; asset: ReturnType<typeof safeAsset> }
  | { status: 'rejected'; code: number; message: string };

const presignItemForUser = async (
  userId: string,
  { filename, contentType, size }: PresignItem,
): Promise<PresignResult> => {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { status: 'rejected', code: 400, message: 'File type is not allowed' };
  }
  if (size > MAX_ASSET_SIZE) {
    return { status: 'rejected', code: 413, message: 'File is too large (max 15 MB)' };
  }

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
  return { status: 'ok', uploadUrl, asset: safeAsset(asset) };
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

    const result = await presignItemForUser(req.user?.id as string, parsed.data);
    if (result.status === 'rejected') {
      return res.status(result.code).json({ message: result.message });
    }
    return res.status(201).json({ uploadUrl: result.uploadUrl, asset: result.asset });
  } catch (err) {
    console.error('Asset presign error:', err);
    return res.status(500).json({ message: 'Error preparing upload' });
  }
});

// Bulk upload (issue #68): many files via N normal singleton uploads, one
// batched presign round-trip. Not a zip container — zip is never an accepted
// upload format at any layer (see ALLOWED_CONTENT_TYPES above), and uploaded
// archives are never read or unzipped anywhere.
router.post('/bulk-presign', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!isStorageConfigured()) {
      return res.status(503).json({ message: 'File storage is not configured' });
    }
    // Coarse total-size guard on the unvalidated body: over the declared cap
    // is a payload too big to bother validating (413), and the batch-shape
    // checks below cover anything finer than that.
    if (Array.isArray(req.body)) {
      const rawTotal = req.body.reduce(
        (sum, item) =>
          sum + (typeof item?.size === 'number' && Number.isFinite(item.size) ? item.size : 0),
        0,
      );
      if (rawTotal > MAX_BULK_TOTAL_SIZE) {
        return res
          .status(413)
          .json({ message: 'Combined file size exceeds the bulk upload limit' });
      }
    }
    const parsed = assetBulkPresignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.issues[0]?.message ?? 'Invalid bulk upload request',
      });
    }
    const declaredTotal = parsed.data.reduce((sum, item) => sum + item.size, 0);
    if (declaredTotal > MAX_BULK_TOTAL_SIZE) {
      return res.status(413).json({ message: 'Combined file size exceeds the bulk upload limit' });
    }

    const results = [];
    for (const item of parsed.data) {
      try {
        const result = await presignItemForUser(req.user?.id as string, item);
        results.push(
          result.status === 'ok'
            ? {
                status: 'ok',
                filename: item.filename,
                asset: result.asset,
                uploadUrl: result.uploadUrl,
              }
            : { status: 'rejected', filename: item.filename, message: result.message },
        );
      } catch (err) {
        console.error('Asset bulk presign item error:', err);
        results.push({
          status: 'rejected',
          filename: item.filename,
          message: 'Error preparing upload',
        });
      }
    }
    return res.status(201).json({ results });
  } catch (err) {
    console.error('Asset bulk presign error:', err);
    return res.status(500).json({ message: 'Error preparing upload' });
  }
});

// Core of POST /:id/confirm (and, per #68, of the bulk confirm per-item
// loop): assumes the asset row is already known to belong to the caller —
// ownership is the caller's lookup (a foreign id must read as "not found",
// never as an error row). Returns a typed rejection instead of throwing so
// bulk can map per-item outcomes; the single route maps the same shape to a
// status code.
type ConfirmResult =
  | { status: 'ok'; asset: ReturnType<typeof safeAsset> }
  | { status: 'rejected'; code: number; message: string };

const confirmAsset = async (asset: AssetDocument): Promise<ConfirmResult> => {
  if (asset.status !== 'pending') {
    return { status: 'rejected', code: 409, message: 'Asset was already confirmed' };
  }
  if (Date.now() - new Date(asset.createdAt).getTime() > CONFIRM_MAX_AGE_MS) {
    asset.status = 'failed';
    asset.failureReason = 'expired';
    await asset.save();
    return { status: 'rejected', code: 409, message: 'Upload window has expired' };
  }

  let head;
  try {
    head = await headObject(asset.key);
  } catch (err) {
    console.error('Asset confirm HEAD error:', err);
    asset.status = 'failed';
    asset.failureReason = 'upload-not-found';
    await asset.save();
    return { status: 'rejected', code: 409, message: 'Upload was not found in storage' };
  }

  if (head.size <= 0 || head.size > MAX_ASSET_SIZE) {
    asset.status = 'failed';
    asset.failureReason = 'size';
    await asset.save();
    return { status: 'rejected', code: 413, message: 'Stored file size is invalid' };
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
  // Issue #67: fast-path extraction won, nothing to convert. Otherwise
  // queue a background conversion job — the response latency of /confirm
  // stays low, conversion retries under the job cap, and a failed
  // conversion never fails the asset (the binary is fine).
  if (text === null && isConvertible(asset.filename)) {
    asset.markdownStatus = 'pending';
    asset.markdownFailureReason = null;
    await asset.save();
    // Enqueue is best-effort: the asset is confirmed and the binary is
    // fine, so a failed enqueue must not 500 the confirm. Reverting to
    // 'none' avoids a forever-'pending' badge on an asset no poller will
    // ever claim a job for; the failure is logged for diagnosis.
    try {
      await enqueueAssetJob(asset._id);
    } catch (enqueueErr) {
      asset.markdownStatus = 'none';
      console.error('Asset conversion enqueue error:', enqueueErr);
      await Asset.updateOne(
        { _id: asset._id, markdownStatus: 'pending' },
        { $set: { markdownStatus: 'none' } },
      );
    }
    return { status: 'ok', asset: safeAsset(asset) };
  }
  await asset.save();
  return { status: 'ok', asset: safeAsset(asset) };
};

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
    const result = await confirmAsset(asset);
    if (result.status === 'rejected') {
      return res.status(result.code).json({ message: result.message });
    }
    return res.json({ asset: result.asset });
  } catch (err) {
    console.error('Asset confirm error:', err);
    return res.status(500).json({ message: 'Error confirming upload' });
  }
});

// POST /api/assets/bulk-confirm — per-item confirm for a batch (issue #68).
// Each id is looked up scoped to the caller: a foreign or unknown id is a
// per-item "not found" row, never a route-level 404. Errors are per-item so
// partial success stays visible per file; no transaction is possible across
// Spaces PUTs anyway.
router.post('/bulk-confirm', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = assetBulkConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.issues[0]?.message ?? 'Invalid bulk confirm request',
      });
    }

    const results = [];
    for (const { assetId } of parsed.data) {
      if (!isValidObjectId(assetId)) {
        results.push({ status: 'rejected', assetId, message: 'Asset not found' });
        continue;
      }
      try {
        const asset = await Asset.findOne({ _id: assetId, userId: req.user?.id });
        if (!asset) {
          results.push({ status: 'rejected', assetId, message: 'Asset not found' });
          continue;
        }
        const result = await confirmAsset(asset);
        results.push(
          result.status === 'ok'
            ? { status: 'ok', assetId, asset: result.asset }
            : { status: 'rejected', assetId, message: result.message },
        );
      } catch (err) {
        console.error('Asset bulk confirm item error:', err);
        results.push({ status: 'rejected', assetId, message: 'Error confirming upload' });
      }
    }
    return res.json({ results });
  } catch (err) {
    console.error('Asset bulk confirm error:', err);
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
// same repeated `?id=` contract as bulk download. Doc-only for now: Spaces
// objects are left resident (decided #69 review), so a later soft-delete /
// restore can flip this to an archive without data loss.
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
    const result = await Asset.deleteMany({
      _id: { $in: requested },
      userId: req.user?.id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    return res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('Asset bulk delete error:', err);
    return res.status(500).json({ message: 'Error deleting assets' });
  }
});

// DELETE /api/assets/:id — doc-only delete; the Spaces object stays resident
// (decided #69 review) so nothing is lost if a restore feature arrives. A
// missing object is therefore not a concern for the delete path itself.
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
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
