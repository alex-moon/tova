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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EXTRACT_BYTES = exports.CONFIRM_MAX_AGE_MS = exports.confirmAsset = void 0;
const Asset_1 = require("../models/Asset");
const workspaceStorage_1 = require("./workspaceStorage");
const assetLimits_1 = require("./assetLimits");
const assetJobService_1 = require("./assetJobService");
const markdownConversion_1 = require("./markdownConversion");
const textExtraction_1 = require("./textExtraction");
const assetViews_1 = require("./assetViews");
// Presign + confirm headroom: pending assets older than this cannot be
// confirmed, so stale rows never revive (plan honest-boundaries for #34).
const CONFIRM_MAX_AGE_MS = 60 * 60 * 1000;
exports.CONFIRM_MAX_AGE_MS = CONFIRM_MAX_AGE_MS;
// Extraction stays light: only objects up to this size are pulled back.
const MAX_EXTRACT_BYTES = 1000000;
exports.MAX_EXTRACT_BYTES = MAX_EXTRACT_BYTES;
const confirmAsset = (asset) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    if (asset.status !== 'pending') {
        return { status: 'rejected', code: 409, message: 'Asset was already confirmed' };
    }
    if (Date.now() - new Date(asset.createdAt).getTime() > CONFIRM_MAX_AGE_MS) {
        asset.status = 'failed';
        asset.failureReason = 'expired';
        yield asset.save();
        return { status: 'rejected', code: 409, message: 'Upload window has expired' };
    }
    let head;
    try {
        head = yield workspaceStorage_1.spacesWorkspaceStorage.headByKey(asset.key);
    }
    catch (err) {
        console.error('Asset confirm HEAD error:', err);
        asset.status = 'failed';
        asset.failureReason = 'upload-not-found';
        yield asset.save();
        return { status: 'rejected', code: 409, message: 'Upload was not found in storage' };
    }
    if (head.size <= 0 || head.size > assetLimits_1.MAX_ASSET_SIZE) {
        asset.status = 'failed';
        asset.failureReason = 'size';
        yield asset.save();
        return { status: 'rejected', code: 413, message: 'Stored file size is invalid' };
    }
    asset.size = head.size;
    if (head.contentType)
        asset.contentType = head.contentType;
    let text = null;
    if ((0, textExtraction_1.isExtractable)(asset.filename) && head.size <= MAX_EXTRACT_BYTES) {
        const buf = yield workspaceStorage_1.spacesWorkspaceStorage.getByKey(asset.key);
        if (buf)
            text = (0, textExtraction_1.truncateForPrompt)((_a = (0, textExtraction_1.extractText)(asset.filename, buf)) !== null && _a !== void 0 ? _a : '');
        if (text !== null)
            asset.textExtracted = text === '' ? null : text;
    }
    asset.status = 'ready';
    // Ephemeral assets (#116) never queue work: the job would keep derived
    // objects alive in storage after the turn deletes the row and bytes.
    // Fast-path extraction already covers the turn's prompt needs.
    // Issue #67: fast-path extraction won, nothing to convert. Otherwise queue
    // a background conversion job — the response latency of /confirm stays low,
    // conversion retries under the job cap, and a failed conversion never fails
    // the asset (the binary is fine).
    // Issue #208: images additionally queue a thumbnail job so the /assets
    // viewer never loads the original; the two pending lifecycles share one job.
    // Issue #209: images also queue OCR, so they now drive the markdown
    // lifecycle too (the processor branches on image content type before the
    // convertible guard).
    const isImage = (0, assetLimits_1.isImageContentType)(asset.contentType);
    const needsConversion = text === null && (0, markdownConversion_1.isConvertible)(asset.filename);
    const needsOcr = isImage;
    const needsThumbnail = isImage;
    if ((needsConversion || needsOcr || needsThumbnail) && !asset.ephemeral) {
        if (needsConversion || needsOcr) {
            asset.markdownStatus = 'pending';
            asset.markdownFailureReason = null;
        }
        if (needsThumbnail) {
            asset.thumbnailStatus = 'pending';
            asset.thumbnailKey = null;
        }
        yield asset.save();
        // Enqueue is best-effort: the asset is confirmed and the binary is
        // fine, so a failed enqueue must not 500 the confirm. Reverting the
        // pending flags avoids a forever-'pending' badge on an asset no poller
        // will ever claim a job for; the failure is logged for diagnosis.
        try {
            yield (0, assetJobService_1.enqueueAssetJob)(asset._id);
        }
        catch (enqueueErr) {
            console.error('Asset job enqueue error:', enqueueErr);
            const revert = {};
            if (needsConversion || needsOcr)
                revert.markdownStatus = 'none';
            if (needsThumbnail)
                revert.thumbnailStatus = 'none';
            yield Asset_1.Asset.updateOne({ _id: asset._id }, { $set: revert });
            if (needsConversion || needsOcr)
                asset.markdownStatus = 'none';
            if (needsThumbnail)
                asset.thumbnailStatus = 'none';
        }
        return { status: 'ok', asset: (0, assetViews_1.safeAsset)(asset) };
    }
    yield asset.save();
    return { status: 'ok', asset: (0, assetViews_1.safeAsset)(asset) };
});
exports.confirmAsset = confirmAsset;
