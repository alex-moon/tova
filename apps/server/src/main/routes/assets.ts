import express from 'express';
import archiver from 'archiver';
import { isValidObjectId } from 'mongoose';
import { Asset, type AssetDocument } from '../models/Asset';
import { AssetVersion } from '../models/AssetVersion';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  assetBulkConfirmSchema,
  assetBulkDeleteQuerySchema,
  assetBulkDownloadQuerySchema,
  assetBulkPresignSchema,
  assetPresignSchema,
  assetRestoreSchema,
} from '../validation';
import { spacesWorkspaceStorage } from '../services/workspaceStorage';
// Domain cores live in services/: presign/confirm, views, zip helpers, shared caps.
import { presignItemForUser } from '../services/assetPresign';
import { confirmAsset } from '../services/assetConfirm';
import { restoreAssetVersion } from '../services/assetEditService';
import { previewAsset, safeAsset } from '../services/assetViews';
import { dedupeEntryNames } from '../services/assetZip';
import { BULK_MAX_TOTAL_SIZE, MAX_BULK_TOTAL_SIZE } from '../services/assetLimits';

const router = express.Router();

const LIST_PAGE_SIZE = 20;

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
    // Gate ephemeral chat uploads on the effective per-chat incognito flag.
    // @see #116 #144
    const user = await User.findById(req.user?.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    /* The effective per-chat flag mirrors the chat routes: a stored chat's flag decides; a new chat uses the composer intent or the profile default. Assets-page uploads are never ephemeral. */
    // @see #144
    let incognitoChat = false;
    if (parsed.data.chatId !== undefined) {
      if (!isValidObjectId(parsed.data.chatId)) {
        return res.status(400).json({ message: 'Invalid chat id' });
      }
      const chat = await Session.findOne({
        _id: parsed.data.chatId,
        userId: req.user?.id,
        deletedAt: null,
      });
      if (!chat) {
        return res.status(404).json({ message: 'Session not found' });
      }
      incognitoChat = Boolean(chat.incognito);
    } else {
      incognitoChat = parsed.data.zdr ?? Boolean(user?.settings?.zdr);
    }

    const result = await presignItemForUser(req.user?.id as string, parsed.data, {
      ephemeral: parsed.data.scope === 'chat' && incognitoChat,
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

// Bulk upload: many files via N singleton uploads, one batched presign round-trip; zip is never an accepted upload format.
// @see #68
router.post('/bulk-presign', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!spacesWorkspaceStorage.isConfigured()) {
      return res.status(503).json({ message: 'File storage is not configured' });
    }
    // Coarse total-size guard on the unvalidated body: over the cap is 413 without validation; finer checks run below.
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

// The browser has PUT the object directly to Spaces; verify existence and size against the real Space so a lying client cannot mark an asset ready.
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

// Per-item confirm for a batch: ids scoped to the caller, errors per-item so partial success stays visible.
// @see #68
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
    // Ephemeral ZDR attachments never appear here; agent-side material is excluded by default — `?origin=system-side` flips to ONLY agent-side rows.
    // @see #116 #340
    const agentSideOnly = req.query.origin === 'system-side';
    const query: Record<string, unknown> = {
      userId,
      ephemeral: { $ne: true },
      origin: agentSideOnly ? 'system-side' : { $ne: 'system-side' },
    };
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

// Server-generated zip of owned assets, streamed from Spaces — never buffered in memory. Any generic GET /:id route must register AFTER this one.
// @see #69
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
    // All ids malformed would otherwise leave an id-less find — a whole-library download bypassing the cap — so refuse.
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

    // Headers are not written until the first zip byte flushes, so the first object is fetched before any header and a first-asset storage failure can still return clean JSON.
    let started = false;
    const startResponse = () => {
      if (started) return;
      started = true;
      archive.on('error', (err: archiver.ArchiverError) => {
        console.error('Archive error:', err);
        res.destroy();
      });
      // Client gave up: stop feeding the zip.
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
          // Mid-stream: browsers will see a truncated zip (accepted limitation).
          // @see #69
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

// In-app viewer payload: the extracted body, ownership-scoped; the /content suffix cannot shadow /:id/url.
// @see #197
router.get('/:id/content', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    return res.json({ asset: previewAsset(asset) });
  } catch (err) {
    console.error('Asset content error:', err);
    return res.status(500).json({ message: 'Error loading asset content' });
  }
});

// Content history of an assistant-generated file, newest first; only metadata — text comes from the /content route.
// @see #325
router.get('/:id/versions', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    const rows = await AssetVersion.find({ assetId: asset._id, userId: req.user?.id })
      .sort({ version: -1 })
      .select('version size createdAt')
      .lean();
    return res.json({
      versions: rows.map((row) => ({
        version: row.version,
        size: row.size,
        createdAt: row.createdAt,
      })),
    });
  } catch (err) {
    console.error('Asset versions error:', err);
    return res.status(500).json({ message: 'Error loading file versions' });
  }
});

// One version's body, for the viewer's read-only version preview; ownership-scoped.
// @see #325
router.get('/:id/versions/:version/content', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ message: 'Invalid version' });
    }
    const row = await AssetVersion.findOne({
      assetId: asset._id,
      userId: req.user?.id,
      version,
    }).select('version size textExtracted createdAt');
    if (!row) {
      return res.status(404).json({ message: 'Version not found' });
    }
    return res.json({
      version: {
        version: row.version,
        size: row.size,
        content: row.textExtracted ?? null,
        format: 'markdown',
        createdAt: row.createdAt,
      },
    });
  } catch (err) {
    console.error('Asset version content error:', err);
    return res.status(500).json({ message: 'Error loading file version' });
  }
});

// Restore a prior version as a NEW version, so a restore is itself undoable; only assistant-generated files are editable.
// @see #325
router.post('/:id/restore', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    const parsed = assetRestoreSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const result = await restoreAssetVersion(asset, parsed.data.version);
    if (!result.ok) {
      const status =
        result.code === 'not_found'
          ? 404
          : result.code === 'too_large'
            ? 413
            : result.code === 'unavailable'
              ? 503
              : 400;
      return res.status(status).json({ message: result.message });
    }
    return res.json({ asset: safeAsset(result.asset) });
  } catch (err) {
    console.error('Asset restore error:', err);
    return res.status(500).json({ message: 'Error restoring file version' });
  }
});

// Presigned GET for the derived image thumbnail so the viewer never loads the original; always 200 for an owned asset, so the client can poll the in-flight state.
// @see #208
router.get('/:id/thumbnail-url', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    if (asset.thumbnailStatus !== 'ready' || !asset.thumbnailKey) {
      return res.json({ url: null, status: asset.thumbnailStatus });
    }
    const url = await spacesWorkspaceStorage.presignGetByKey(asset.thumbnailKey, 300);
    return res.json({ url, status: 'ready' });
  } catch (err) {
    console.error('Asset thumbnail url error:', err);
    return res.status(500).json({ message: 'Error signing thumbnail URL' });
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

// Bulk delete of owned assets with the same repeated `?id=` contract as bulk download; Spaces objects stay resident (doc-only delete).
// @see #69
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

// Doc-only delete; the Spaces object stays resident so nothing is lost if a restore feature arrives.
// @see #69
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
