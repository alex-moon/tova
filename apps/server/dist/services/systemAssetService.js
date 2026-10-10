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
exports.createSystemAsset = void 0;
const Asset_1 = require("../models/Asset");
const workspaceStorage_1 = require("./workspaceStorage");
const assetLimits_1 = require("./assetLimits");
// The generator emits markdown files only for now (`text/markdown`; the
// alias stays accepted because presign has always allowed it). Widening the
// family (plain text, code execution output) is a one-line change here since
// the full upload allowlist intentionally stays out of this stricter path.
const SYSTEM_ALLOWED_CONTENT_TYPES = new Set(['text/markdown', 'text/x-markdown']);
const fail = (code, message) => ({
    ok: false,
    code,
    message,
});
const createSystemAsset = (userId, filename, buffer, contentType) => __awaiter(void 0, void 0, void 0, function* () {
    if (!SYSTEM_ALLOWED_CONTENT_TYPES.has(contentType)) {
        return fail('invalid', `Content type ${contentType} is not allowed for generated files`);
    }
    if (buffer.length === 0) {
        return fail('invalid', 'Generated file is empty');
    }
    if (buffer.length > assetLimits_1.MAX_ASSET_SIZE) {
        return fail('too_large', 'Generated file is too large (max 15 MB)');
    }
    const safeName = (0, assetLimits_1.sanitizeFilename)(filename);
    if (!safeName) {
        return fail('invalid', 'Generated filename is invalid');
    }
    const asset = yield Asset_1.Asset.create({
        userId,
        filename: safeName,
        key: 'pending',
        contentType,
        size: buffer.length,
        status: 'pending',
        origin: 'system-generated',
    });
    const key = `${userId}/${asset._id}/${safeName}`;
    try {
        yield workspaceStorage_1.spacesWorkspaceStorage.putByKey(key, buffer, contentType);
    }
    catch (err) {
        asset.status = 'failed';
        asset.failureReason = 'storage-error';
        yield asset.save();
        throw err;
    }
    asset.key = key;
    // The full buffer is the text by construction; no extraction step needed.
    // Per OQ4 the FULL text is stored — the 12k cap applies only at
    // prompt-assembly time (truncateForPrompt there, not here).
    const text = buffer.toString('utf8');
    asset.textExtracted = text || null;
    asset.status = 'ready';
    yield asset.save();
    return {
        ok: true,
        fileId: String(asset._id),
        filename: asset.filename,
        size: asset.size,
        createdAt: asset.createdAt,
    };
});
exports.createSystemAsset = createSystemAsset;
