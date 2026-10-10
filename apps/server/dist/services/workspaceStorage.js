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
exports.spacesWorkspaceStorage = exports.chatScopedKey = void 0;
const storageService_1 = require("./storageService");
// Chat-scoped key layout used ONLY by new writes going through the
// chat-scoped methods (the future workspace feature). Asset writes keep the
// existing `<userId>/<assetId>/<filename>` layout on the Asset row. The
// `chats/` segment in the second position makes the two layouts structurally
// disjoint even when chatId values look like asset ObjectIds, so no
// migration is ever needed.
const chatScopedKey = (userId, chatId, filename) => `${userId}/chats/${chatId}/${filename}`;
exports.chatScopedKey = chatScopedKey;
// The single Spaces-backed implementation over the existing storageService
// driver. Call sites (once rewired across checklist items 2-6) import only
// this object, never the driver.
exports.spacesWorkspaceStorage = {
    isConfigured: storageService_1.isStorageConfigured,
    put: (userId, chatId, filename, body, contentType) => (0, storageService_1.putObject)((0, exports.chatScopedKey)(userId, chatId, filename), body, contentType),
    get: (userId, chatId, filename, opts) => (0, storageService_1.getObjectBuffer)((0, exports.chatScopedKey)(userId, chatId, filename), opts === null || opts === void 0 ? void 0 : opts.maxBytes),
    getStream: (userId, chatId, filename) => (0, storageService_1.getObjectStream)((0, exports.chatScopedKey)(userId, chatId, filename)),
    delete: (userId, chatId, filename) => (0, storageService_1.deleteObject)((0, exports.chatScopedKey)(userId, chatId, filename)),
    // No caller enumerates a chat prefix yet (none ever did through the old
    // driver either), so list has no inherited behaviour to preserve; throw
    // rather than silently return empty so the future workspace feature wires
    // it to a real listing when it lands.
    list: () => __awaiter(void 0, void 0, void 0, function* () {
        throw new Error('workspaceStorage.list is not implemented yet (no caller exists)');
    }),
    // Bulk chat-scoped sweep (issue #143 factory reset): delete every object
    // under each chat's prefix, filenames unknown — the only enumerating
    // operation on this boundary. Returns the keys whose deletion failed
    // (error or falsy); when storage is unconfigured there is nothing on the
    // bucket to sweep, so it resolves empty.
    deleteChatFiles: (userId, chatIds) => __awaiter(void 0, void 0, void 0, function* () {
        const failed = [];
        if (!(0, storageService_1.isStorageConfigured)())
            return failed;
        for (const chatId of chatIds) {
            const keys = yield (0, storageService_1.listObjectKeys)((0, exports.chatScopedKey)(userId, chatId, ''));
            for (const key of keys) {
                try {
                    if (!(yield (0, storageService_1.deleteObject)(key)))
                        failed.push(key);
                }
                catch (_a) {
                    failed.push(key);
                }
            }
        }
        return failed;
    }),
    putByKey: storageService_1.putObject,
    getByKey: (key, opts) => (0, storageService_1.getObjectBuffer)(key, opts === null || opts === void 0 ? void 0 : opts.maxBytes),
    getStreamByKey: storageService_1.getObjectStream,
    headByKey: storageService_1.headObject,
    deleteByKey: storageService_1.deleteObject,
    presignPutByKey: storageService_1.presignPutUrl,
    presignGetByKey: storageService_1.presignGetUrl,
};
