"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const archiver_1 = __importDefault(require("archiver"));
const mongoose_1 = require("mongoose");
const Asset_1 = require("../models/Asset");
const Session_1 = require("../models/Session");
const User_1 = require("../models/User");
const auth_1 = require("../middleware/auth");
const validation_1 = require("../validation");
const workspaceStorage_1 = require("../services/workspaceStorage");
// Presign/confirm domain cores live in services/assetPresign.ts and
// services/assetConfirm.ts; asset views in services/assetViews.ts; zip-entry
// helpers in services/assetZip.ts; shared caps in services/assetLimits.ts.
const assetPresign_1 = require("../services/assetPresign");
const assetConfirm_1 = require("../services/assetConfirm");
const assetViews_1 = require("../services/assetViews");
const assetZip_1 = require("../services/assetZip");
const assetLimits_1 = require("../services/assetLimits");
const router = express_1.default.Router();
const LIST_PAGE_SIZE = 20;
const ownedAsset = (req) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const asset = yield Asset_1.Asset.findOne({
        _id: req.params.id,
        userId: (_a = req.user) === null || _a === void 0 ? void 0 : _a.id,
    });
    return asset;
});
// POST /api/assets/presign — mints the upload URL; no bytes reach Express.
router.post('/presign', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    try {
        if (!workspaceStorage_1.spacesWorkspaceStorage.isConfigured()) {
            return res.status(503).json({ message: 'File storage is not configured' });
        }
        const parsed = validation_1.assetPresignSchema.safeParse((_a = req.body) !== null && _a !== void 0 ? _a : {});
        if (!parsed.success) {
            return res.status(400).json({
                message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid upload request',
            });
        }
        // Needed to gate ephemeral chat uploads (#116) on the effective per-chat
        // incognito flag (#144).
        const user = yield User_1.User.findById((_d = req.user) === null || _d === void 0 ? void 0 : _d.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        /*
         * (#144) The effective per-chat flag mirrors the chat routes' decision:
         * an existing chat's stored `Session.incognito` decides; a new chat's
         * upload (which must precede session creation, so no session can exist)
         * uses the composer's `zdr` intent or the profile's 'incognito by
         * default'. Assets-page uploads (scope !== 'chat') are never ephemeral.
         */
        let incognitoChat = false;
        if (parsed.data.chatId !== undefined) {
            if (!(0, mongoose_1.isValidObjectId)(parsed.data.chatId)) {
                return res.status(400).json({ message: 'Invalid chat id' });
            }
            const chat = yield Session_1.Session.findOne({
                _id: parsed.data.chatId,
                userId: (_e = req.user) === null || _e === void 0 ? void 0 : _e.id,
                deletedAt: null,
            });
            if (!chat) {
                return res.status(404).json({ message: 'Session not found' });
            }
            incognitoChat = Boolean(chat.incognito);
        }
        else {
            incognitoChat = (_f = parsed.data.zdr) !== null && _f !== void 0 ? _f : Boolean((_g = user === null || user === void 0 ? void 0 : user.settings) === null || _g === void 0 ? void 0 : _g.zdr);
        }
        const result = yield (0, assetPresign_1.presignItemForUser)((_h = req.user) === null || _h === void 0 ? void 0 : _h.id, parsed.data, {
            ephemeral: parsed.data.scope === 'chat' && incognitoChat,
        });
        if (result.status === 'rejected') {
            return res.status(result.code).json({ message: result.message });
        }
        return res.status(201).json({ uploadUrl: result.uploadUrl, asset: result.asset });
    }
    catch (err) {
        console.error('Asset presign error:', err);
        return res.status(500).json({ message: 'Error preparing upload' });
    }
}));
// Bulk upload (issue #68): many files via N normal singleton uploads, one
// batched presign round-trip. Not a zip container — zip is never an accepted
// upload format at any layer (see ALLOWED_CONTENT_TYPES above), and uploaded
// archives are never read or unzipped anywhere.
router.post('/bulk-presign', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        if (!workspaceStorage_1.spacesWorkspaceStorage.isConfigured()) {
            return res.status(503).json({ message: 'File storage is not configured' });
        }
        // Coarse total-size guard on the unvalidated body: over the declared cap
        // is a payload too big to bother validating (413), and the batch-shape
        // checks below cover anything finer than that.
        if (Array.isArray(req.body)) {
            const rawTotal = req.body.reduce((sum, item) => sum + (typeof (item === null || item === void 0 ? void 0 : item.size) === 'number' && Number.isFinite(item.size) ? item.size : 0), 0);
            if (rawTotal > assetLimits_1.MAX_BULK_TOTAL_SIZE) {
                return res
                    .status(413)
                    .json({ message: 'Combined file size exceeds the bulk upload limit' });
            }
        }
        const parsed = validation_1.assetBulkPresignSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                message: (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : 'Invalid bulk upload request',
            });
        }
        const declaredTotal = parsed.data.reduce((sum, item) => sum + item.size, 0);
        if (declaredTotal > assetLimits_1.MAX_BULK_TOTAL_SIZE) {
            return res.status(413).json({ message: 'Combined file size exceeds the bulk upload limit' });
        }
        const results = [];
        for (const item of parsed.data) {
            try {
                const result = yield (0, assetPresign_1.presignItemForUser)((_c = req.user) === null || _c === void 0 ? void 0 : _c.id, item);
                results.push(result.status === 'ok'
                    ? {
                        status: 'ok',
                        filename: item.filename,
                        asset: result.asset,
                        uploadUrl: result.uploadUrl,
                    }
                    : { status: 'rejected', filename: item.filename, message: result.message });
            }
            catch (err) {
                console.error('Asset bulk presign item error:', err);
                results.push({
                    status: 'rejected',
                    filename: item.filename,
                    message: 'Error preparing upload',
                });
            }
        }
        return res.status(201).json({ results });
    }
    catch (err) {
        console.error('Asset bulk presign error:', err);
        return res.status(500).json({ message: 'Error preparing upload' });
    }
}));
// POST /api/assets/:id/confirm — browser has PUT the object directly to
// Spaces; verify it really exists at the expected size, extract light text,
// and mark it ready. Net object checks run against the real Space so a
// lying client cannot mark an asset ready.
router.post('/:id/confirm', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const asset = yield ownedAsset(req);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        const result = yield (0, assetConfirm_1.confirmAsset)(asset);
        if (result.status === 'rejected') {
            return res.status(result.code).json({ message: result.message });
        }
        return res.json({ asset: result.asset });
    }
    catch (err) {
        console.error('Asset confirm error:', err);
        return res.status(500).json({ message: 'Error confirming upload' });
    }
}));
// POST /api/assets/bulk-confirm — per-item confirm for a batch (issue #68).
// Each id is looked up scoped to the caller: a foreign or unknown id is a
// per-item "not found" row, never a route-level 404. Errors are per-item so
// partial success stays visible per file; no transaction is possible across
// Spaces PUTs anyway.
router.post('/bulk-confirm', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const parsed = validation_1.assetBulkConfirmSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                message: (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : 'Invalid bulk confirm request',
            });
        }
        const results = [];
        for (const { assetId } of parsed.data) {
            if (!(0, mongoose_1.isValidObjectId)(assetId)) {
                results.push({ status: 'rejected', assetId, message: 'Asset not found' });
                continue;
            }
            try {
                const asset = yield Asset_1.Asset.findOne({ _id: assetId, userId: (_c = req.user) === null || _c === void 0 ? void 0 : _c.id });
                if (!asset) {
                    results.push({ status: 'rejected', assetId, message: 'Asset not found' });
                    continue;
                }
                const result = yield (0, assetConfirm_1.confirmAsset)(asset);
                results.push(result.status === 'ok'
                    ? { status: 'ok', assetId, asset: result.asset }
                    : { status: 'rejected', assetId, message: result.message });
            }
            catch (err) {
                console.error('Asset bulk confirm item error:', err);
                results.push({ status: 'rejected', assetId, message: 'Error confirming upload' });
            }
        }
        return res.json({ results });
    }
    catch (err) {
        console.error('Asset bulk confirm error:', err);
        return res.status(500).json({ message: 'Error confirming upload' });
    }
}));
// GET /api/assets — cursor-paged, strictly scoped to the caller.
router.get('/', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.id;
        // Ephemeral ZDR chat attachments (#116) live for one turn at most; the
        // library view is for durable files, so they never appear here.
        const query = { userId, ephemeral: { $ne: true } };
        const cursor = req.query.cursor;
        if (typeof cursor === 'string' && (0, mongoose_1.isValidObjectId)(cursor)) {
            query._id = { $lt: cursor };
        }
        const assets = yield Asset_1.Asset.find(query)
            .sort({ _id: -1 })
            .limit(LIST_PAGE_SIZE + 1);
        const hasMore = assets.length > LIST_PAGE_SIZE;
        const page = hasMore ? assets.slice(0, LIST_PAGE_SIZE) : assets;
        return res.json({
            assets: page.map(assetViews_1.safeAsset),
            nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
        });
    }
    catch (err) {
        console.error('Asset list error:', err);
        return res.status(500).json({ message: 'Error listing assets' });
    }
}));
// GET /api/assets/bulk-download — server-generated zip of owned assets
// (issue #69). Streams each stored object from Spaces into `archiver` —
// never buffered in memory. NOTE: any future generic `GET /:id` route must
// be registered *after* this one so `bulk-download` is not swallowed.
router.get('/bulk-download', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const ids = req.query.id;
    const parsed = validation_1.assetBulkDownloadQuerySchema.safeParse({ id: ids });
    if (!parsed.success) {
        return res.status(400).json({
            message: (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : 'Invalid bulk download request',
        });
    }
    try {
        const requested = parsed.data.id.filter((id) => (0, mongoose_1.isValidObjectId)(id));
        // Every id malformed would otherwise leave an id-less find — a whole-
        // library download that bypasses the 50-id cap — so refuse instead.
        if (requested.length === 0) {
            return res.status(400).json({ message: 'No valid asset ids in selection' });
        }
        const assets = yield Asset_1.Asset.find({
            _id: { $in: requested },
            userId: (_c = req.user) === null || _c === void 0 ? void 0 : _c.id,
            status: 'ready',
        })
            .select('filename key size')
            .lean();
        if (assets.length === 0) {
            return res.status(400).json({ message: 'No downloadable assets in selection' });
        }
        const totalSize = assets.reduce((sum, asset) => { var _a; return sum + ((_a = asset.size) !== null && _a !== void 0 ? _a : 0); }, 0);
        if (totalSize > assetLimits_1.BULK_MAX_TOTAL_SIZE) {
            return res.status(413).json({ message: 'Selected assets exceed the 500 MB archive limit' });
        }
        const entryNames = (0, assetZip_1.dedupeEntryNames)(assets.map((asset) => asset.filename));
        const archive = (0, archiver_1.default)('zip', { zlib: { level: 6 } });
        archive.on('warning', (err) => console.error('Archive warning:', err));
        // Headers are not written until the first byte of zip data flushes; the
        // first streamed object is therefore fetched before any header, so a
        // storage failure on the very first asset can still return clean JSON.
        let started = false;
        const startResponse = () => {
            if (started)
                return;
            started = true;
            archive.on('error', (err) => {
                console.error('Archive error:', err);
                res.destroy();
            });
            // Client gave up / connection dropped: stop feeding the zip.
            res.on('close', () => archive.abort());
            res.type('application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="assets-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.zip"`);
            archive.pipe(res);
        };
        for (let i = 0; i < assets.length; i += 1) {
            const asset = assets[i];
            try {
                const body = yield workspaceStorage_1.spacesWorkspaceStorage.getStreamByKey(asset.key);
                if (!body) {
                    startResponse();
                    archive.append('', { name: `${entryNames[i]}.missing` });
                    continue;
                }
                startResponse();
                archive.append(body, { name: entryNames[i] });
            }
            catch (err) {
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
        yield archive.finalize();
    }
    catch (err) {
        console.error('Asset bulk download error:', err);
        if (!res.headersSent) {
            return res.status(500).json({ message: 'Error building download archive' });
        }
        // Headers already sent mid-stream: browsers will see a truncated zip.
        res.destroy();
    }
}));
// GET /api/assets/:id/content — in-app viewer payload (issue #197): the
// extracted body (`textExtracted ?? markdownExtracted`), ownership-scoped.
// Registered after `/bulk-download` per the ordering note above; uses the
// `/content` suffix so it cannot shadow `/:id/url`.
router.get('/:id/content', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const asset = yield ownedAsset(req);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        return res.json({ asset: (0, assetViews_1.previewAsset)(asset) });
    }
    catch (err) {
        console.error('Asset content error:', err);
        return res.status(500).json({ message: 'Error loading asset content' });
    }
}));
// GET /api/assets/:id/thumbnail-url — presigned GET for the derived image
// thumbnail (issue #208), so the viewer never loads the original. Ownership-
// scoped like /:id/url. Always 200 for an owned asset, returning the current
// `thumbnailStatus` and a `url` only once ready, so the client can poll the
// in-flight state instead of guessing from a status code.
router.get('/:id/thumbnail-url', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const asset = yield ownedAsset(req);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        if (asset.thumbnailStatus !== 'ready' || !asset.thumbnailKey) {
            return res.json({ url: null, status: asset.thumbnailStatus });
        }
        const url = yield workspaceStorage_1.spacesWorkspaceStorage.presignGetByKey(asset.thumbnailKey, 300);
        return res.json({ url, status: 'ready' });
    }
    catch (err) {
        console.error('Asset thumbnail url error:', err);
        return res.status(500).json({ message: 'Error signing thumbnail URL' });
    }
}));
// GET /api/assets/:id/url — short-expiry presigned GET; objects stay private.
router.get('/:id/url', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const asset = yield ownedAsset(req);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        if (asset.status !== 'ready') {
            return res.status(409).json({ message: 'Asset is not ready for download' });
        }
        const url = yield workspaceStorage_1.spacesWorkspaceStorage.presignGetByKey(asset.key, 300);
        return res.json({ url });
    }
    catch (err) {
        console.error('Asset url error:', err);
        return res.status(500).json({ message: 'Error signing download URL' });
    }
}));
// DELETE /api/assets/bulk-delete — batch delete of owned assets with the
// same repeated `?id=` contract as bulk download. Doc-only for now: Spaces
// objects are left resident (decided #69 review), so a later soft-delete /
// restore can flip this to an archive without data loss.
router.delete('/bulk-delete', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const ids = req.query.id;
    const parsed = validation_1.assetBulkDeleteQuerySchema.safeParse({ id: ids });
    if (!parsed.success) {
        return res.status(400).json({
            message: (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : 'Invalid bulk delete request',
        });
    }
    try {
        const requested = parsed.data.id.filter((id) => (0, mongoose_1.isValidObjectId)(id));
        if (requested.length === 0) {
            return res.status(400).json({ message: 'No valid asset ids in selection' });
        }
        const result = yield Asset_1.Asset.deleteMany({
            _id: { $in: requested },
            userId: (_c = req.user) === null || _c === void 0 ? void 0 : _c.id,
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        return res.json({ success: true, deleted: result.deletedCount });
    }
    catch (err) {
        console.error('Asset bulk delete error:', err);
        return res.status(500).json({ message: 'Error deleting assets' });
    }
}));
// DELETE /api/assets/:id — doc-only delete; the Spaces object stays resident
// (decided #69 review) so nothing is lost if a restore feature arrives. A
// missing object is therefore not a concern for the delete path itself.
router.delete('/:id', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const asset = yield ownedAsset(req);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        const deleted = yield Asset_1.Asset.findByIdAndDelete(asset._id);
        if (!deleted) {
            return res.status(500).json({ message: 'Error deleting asset' });
        }
        return res.json({ success: true });
    }
    catch (err) {
        console.error('Asset delete error:', err);
        return res.status(500).json({ message: 'Error deleting asset' });
    }
}));
exports.default = router;
