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
exports.purgeAllUserData = void 0;
const Session_1 = require("../models/Session");
const Message_1 = require("../models/Message");
const Asset_1 = require("../models/Asset");
const AssetJob_1 = require("../models/AssetJob");
const Entity_1 = require("../models/Entity");
const EntityEdge_1 = require("../models/EntityEdge");
const workspaceStorage_1 = require("./workspaceStorage");
const tracePurge_1 = require("./tracePurge");
const McpServer_1 = require("../models/McpServer");
const purgeAllUserData = (userId) => __awaiter(void 0, void 0, void 0, function* () {
    const failedObjects = [];
    const uid = String(userId);
    // Pre-reads: session ids and asset keys must be fetched before their
    // documents are erased below.
    const [sessions, assets] = yield Promise.all([
        Session_1.Session.find({ userId }).select('_id').lean(),
        Asset_1.Asset.find({ userId }).select('_id key').lean(),
    ]);
    const sessionIds = sessions.map((s) => s._id);
    const assetIds = assets.map((a) => a._id);
    const assetKeys = assets.map((a) => a.key);
    // Mongo sweep — every collection enumerated explicitly (issue #143):
    // messages, the entity graph (free-text names/summaries/edges pointing back
    // into messages), asset docs, the job rows keyed by assetId (AssetJob has
    // no userId, so it is swept via the pre-fetched asset ids), and the
    // user-scoped MCP server configs — platform servers are left alone.
    yield Promise.all([
        Message_1.Message.deleteMany({ sessionId: { $in: sessionIds } }),
        Entity_1.Entity.deleteMany({ userId }),
        EntityEdge_1.EntityEdge.deleteMany({ userId }),
        Asset_1.Asset.deleteMany({ userId }),
        AssetJob_1.AssetJob.deleteMany({ assetId: { $in: assetIds } }),
        McpServer_1.McpServer.deleteMany({ scope: 'user', userId }),
        // Hard delete of ALL owned sessions — soft-deleted ones included; nothing
        // survives a factory reset.
        Session_1.Session.deleteMany({ userId }),
    ]);
    // Spaces sweep: the asset bytes (deleted docs left the bucket keys behind)
    // and the chat-scoped workspace files, which have no Asset row and are
    // therefore swept by session prefix. Both halves gate on isConfigured for
    // the same reason: with no Spaces credentials nothing was ever written to a
    // bucket, so reporting the keys as failed would spuriously warn the user
    // that data remains.
    if (workspaceStorage_1.spacesWorkspaceStorage.isConfigured()) {
        for (const key of assetKeys) {
            try {
                if (!(yield workspaceStorage_1.spacesWorkspaceStorage.deleteByKey(key)))
                    failedObjects.push(key);
            }
            catch (err) {
                console.error('factory reset: object delete failed:', String(err));
                failedObjects.push(key);
            }
        }
    }
    try {
        failedObjects.push(...(yield workspaceStorage_1.spacesWorkspaceStorage.deleteChatFiles(uid, sessionIds.map(String))));
    }
    catch (err) {
        console.error('factory reset: workspace file sweep failed:', String(err));
        // A wholesale sweep failure (listing error, transport down) cannot name
        // individual keys, but reporting zero failures here would tell the user
        // "everything erased" when chat files may still be on the bucket — so a
        // sentinel key is surfaced instead.
        failedObjects.push(`${uid}/chats/*`);
    }
    // Traces: best-effort LangSmith deletion into the configured project;
    // failure-tolerant inside the service, and guarded once more here so any
    // unexpected rethrow cannot abort the reset the user already waited for.
    try {
        yield (0, tracePurge_1.purgeUserTraces)(sessionIds.map(String));
    }
    catch (err) {
        console.error('factory reset: trace purge failed:', String(err));
    }
    return { failedObjects };
});
exports.purgeAllUserData = purgeAllUserData;
