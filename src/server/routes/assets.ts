import express from 'express';
import archiver from 'archiver';
import { isValidObjectId } from 'mongoose';
import { Asset, type AssetDocument } from '../models/Asset';
import { User } from '../models/User';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  assetBulkConfirmSchema,
  assetBulkDeleteQuerySchema,
  assetBulkDownloadQuerySchema,
  assetBulkPresignSchema,
  assetPresignSchema,
  MAX_BULK_TOTAL_SIZE,
} from '../validation';
import { spacesWorkspaceStorage } from '../services/workspaceStorage';
// Presign/confirm domain cores live in services/assetPresign.ts and
// services/assetConfirm.ts; asset views in services/assetViews.ts; zip-entry
// helpers in services/assetZip.ts.
import { presignItemForUser } from '../services/assetPresign';
import { confirmAsset } from '../services/assetConfirm';
import { safeAsset } from '../services/assetViews';
import { dedupeEntryNames } from '../services/assetZip';

const router = express.Router();

const LIST_PAGE_SIZE = 20;

// Bulk zip limits (#69): file count comes from the query schema cap; the
// stored-size cap is the real limiter given the 15 MB per-file presign cap.
const BULK_MAX_TOTAL_SIZE = 500 * 1024 * 1024;

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
    if (!spacesWorkspaceStorage.isConfigured()) {
      return res.status(503).json({ message: 'File storage is not configured' });
    }
    const parsed = assetPresignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.issues[0]?.message ?? 'Invalid upload request',
      });
    }
    // Needed to gate ephemeral chat uploads (#116) on the account's own
    // zero-data-retention setting.
    const user = await User.findById(req.user?.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const result = await presignItemForUser(req.user?.id as string, parsed.data, {
      // ZDR (#116): chat-composer uploads from a ZDR user are kept out of
      // durable storage — the row is dropped after the turn consumes it. The
      // account setting, not the client tag alone, decides.
      ephemeral: parsed.data.scope === 'chat' && Boolean(user?.settings?.zdr),
    });
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
    if (!spacesWorkspaceStorage.isConfigured()) {
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
    // Ephemeral ZDR chat attachments (#116) live for one turn at most; the
    // library view is for durable files, so they never appear here.
    const query: Record<string, unknown> = { userId, ephemeral: { $ne: true } };
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
        const body = await spacesWorkspaceStorage.getStreamByKey(asset.key);
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
    const url = await spacesWorkspaceStorage.presignGetByKey(asset.key, 300);
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
