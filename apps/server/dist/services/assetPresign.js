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
exports.presignItemForUser = void 0;
const Asset_1 = require("../models/Asset");
const workspaceStorage_1 = require("./workspaceStorage");
const assetLimits_1 = require("./assetLimits");
const assetViews_1 = require("./assetViews");
const presignItemForUser = (userId_1, _a, ...args_1) => __awaiter(void 0, [userId_1, _a, ...args_1], void 0, function* (userId, { filename, contentType, size }, opts = {}) {
    if (!assetLimits_1.ALLOWED_CONTENT_TYPES.has(contentType)) {
        return { status: 'rejected', code: 400, message: 'File type is not allowed' };
    }
    if (size > assetLimits_1.MAX_ASSET_SIZE) {
        return { status: 'rejected', code: 413, message: 'File is too large (max 15 MB)' };
    }
    const asset = yield Asset_1.Asset.create(Object.assign({ userId, filename: (0, assetLimits_1.sanitizeFilename)(filename), key: 'pending', contentType,
        size, status: 'pending' }, (opts.ephemeral ? { ephemeral: true } : {})));
    const key = `${userId}/${asset._id}/${(0, assetLimits_1.sanitizeFilename)(filename)}`;
    asset.key = key;
    yield asset.save();
    const uploadUrl = yield workspaceStorage_1.spacesWorkspaceStorage.presignPutByKey(key, 60, contentType);
    return { status: 'ok', uploadUrl, asset: (0, assetViews_1.safeAsset)(asset) };
});
exports.presignItemForUser = presignItemForUser;
