import express from 'express';
import archiver from 'archiver';
import type { Readable } from 'stream';
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
  zodMessage,
} from '../validation';
import { spacesWorkspaceStorage } from '../services/workspaceStorage';
// Domain cores live in services/: presign/confirm, views, zip, caps.
import { presignItemForUser } from '../services/assetPresign';
import { confirmAsset } from '../services/assetConfirm';
import { restoreAssetVersion } from '../services/assetEditService';
import { previewAsset, safeAsset } from '../services/assetViews';
import { dedupeEntryNames } from '../services/assetZip';
import { BULK_MAX_TOTAL_SIZE, MAX_BULK_TOTAL_SIZE } from '../services/assetLimits';
import { cursorPage, LIST_PAGE_SIZE } from '../services/cursorPage';

const router = express.Router();

const ownedAsset = async (req: AuthRequest): Promise<AssetDocument | null> => {
  // Malformed ids are a 404, never a CastError 500.
  // @see #396
  if (!isValidObjectId(req.params.id)) return null;
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
        message: zodMessage(parsed, 'Invalid upload request'),
      });
    }
    // Gate ephemeral chat uploads on the effective per-chat incognito flag.
    // @see #116 #144
    const user = await User.findById(req.user?.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    /* Effective per-chat flag: stored flag, else composer intent/profile. */
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

// Bulk upload: N singleton uploads, one batched presign; never zip.
// @see #68
router.post('/bulk-presign', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!spacesWorkspaceStorage.isConfigured()) {
      return res.status(503).json({ message: 'File storage is not configured' });
    }
    const parsed = assetBulkPresignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: zodMessage(parsed, 'Invalid bulk upload request'),
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

// Browser PUT the object itself; verify size/existence on the real Space.
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

// Per-item batch confirm: scoped ids, per-item errors, partial success.
// @see #68
router.post('/bulk-confirm', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = assetBulkConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: zodMessage(parsed, 'Invalid bulk confirm request'),
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
    // Ephemeral ZDR rows never appear; `?origin=system-side` flips it.
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

    const { page, nextCursor } = cursorPage(assets);
    return res.json({
      assets: page.map(safeAsset),
      nextCursor,
    });
  } catch (err) {
    console.error('Asset list error:', err);
    return res.status(500).json({ message: 'Error listing assets' });
  }
});

// Owned-asset zip streamed from Spaces, never buffered; register GETs after.
// @see #69
router.get('/bulk-download', authenticate, async (req: AuthRequest, res) => {
  const ids = req.query.id;
  const parsed = assetBulkDownloadQuerySchema.safeParse({ id: ids });
  if (!parsed.success) {
    return res.status(400).json({
      message: zodMessage(parsed, 'Invalid bulk download request'),
    });
  }

  try {
    const requested = parsed.data.id.filter((id) => isValidObjectId(id));
    // All-malformed ids would bypass the cap; refuse the request.
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

    // Appended Spaces streams must never outlive the response: every abort
    // path destroys whatever is still feeding the archive.
    // @see #396
    const streams = new Set<Readable>();
    const destroyStreams = () => {
      for (const body of streams) body.destroy();
      streams.clear();
    };
    archive.on('error', (err: archiver.ArchiverError) => {
      console.error('Archive error:', err);
      destroyStreams();
      if (res.headersSent) res.destroy();
      else res.status(500).json({ message: 'Error building download archive' });
    });
    // Client gave up: stop feeding the zip.
    res.on('close', () => {
      archive.abort();
      destroyStreams();
    });

    // First zip byte flushes before headers, so a failure can 500 cleanly.
    let started = false;
    const startResponse = () => {
      if (started) return;
      started = true;
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
        streams.add(body);
        body.on('end', () => streams.delete(body));
        body.on('close', () => streams.delete(body));
        archive.append(body, { name: entryNames[i]! });
      } catch (err) {
        console.error('Asset bulk download stream error:', err);
        archive.abort();
        destroyStreams();
        if (started && res.headersSent) {
          // Mid-stream: browsers see a truncated zip (accepted).
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

// Viewer payload: extracted body; `/content` can't shadow `/:id/url`.
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

// Content history, newest first; metadata only, body via /content.
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

// One version's body for the read-only preview; ownership-scoped.
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

// Restore as a NEW version, so a restore is itself undoable.
// @see #325
router.post('/:id/restore', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    const parsed = assetRestoreSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: zodMessage(parsed, 'Invalid request') });
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
              : result.code === 'conflict'
                ? 409
                : 400;
      return res.status(status).json({ message: result.message });
    }
    return res.json({ asset: safeAsset(result.asset) });
  } catch (err) {
    console.error('Asset restore error:', err);
    return res.status(500).json({ message: 'Error restoring file version' });
  }
});

// Presigned GET for the thumbnail; always 200 so the client can poll.
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

// Bulk delete via repeated `?id=`; the rows carry the only key references,
// so the Spaces objects and thumbnails go with them (best-effort).
// @see #69 #396
router.delete('/bulk-delete', authenticate, async (req: AuthRequest, res) => {
  const ids = req.query.id;
  const parsed = assetBulkDeleteQuerySchema.safeParse({ id: ids });
  if (!parsed.success) {
    return res.status(400).json({
      message: zodMessage(parsed, 'Invalid bulk delete request'),
    });
  }

  try {
    const requested = parsed.data.id.filter((id) => isValidObjectId(id));
    if (requested.length === 0) {
      return res.status(400).json({ message: 'No valid asset ids in selection' });
    }
    const owned = await Asset.find({
      _id: { $in: requested },
      userId: req.user?.id,
    }).select('key thumbnailKey');
    for (const asset of owned) {
      for (const key of [asset.key, asset.thumbnailKey]) {
        if (key && key !== 'pending') {
          await Promise.resolve(spacesWorkspaceStorage.deleteByKey(key)).catch(() => undefined);
        }
      }
    }
    const result = await Asset.deleteMany({
      _id: { $in: owned.map((asset) => asset._id) },
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

// Doc-only delete kept the Spaces bytes for a possible restore — but the
// row held the only keys, so they were unrecoverable. Delete them too.
// @see #396
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const asset = await ownedAsset(req);
    if (!asset) {
      return res.status(404).json({ message: 'Asset not found' });
    }
    for (const key of [asset.key, asset.thumbnailKey]) {
      if (key && key !== 'pending') {
        await Promise.resolve(spacesWorkspaceStorage.deleteByKey(key)).catch(() => undefined);
      }
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
