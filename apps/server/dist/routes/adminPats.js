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
const mongoose_1 = __importDefault(require("mongoose"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("../middleware/auth");
const Pat_1 = require("../models/Pat");
const User_1 = require("../models/User");
const validation_1 = require("../validation");
const router = express_1.default.Router();
// Same guard as admin.ts, but the first leg also accepts PAT bearer auth
// (#184) so the agent/CLI path and the admin-view cookie path share these
// routes.
const adminGuard = [auth_1.authenticateBearerOrSession, (0, auth_1.requireRole)('admin')];
router.get('/pats', ...adminGuard, (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const pats = yield Pat_1.Pat.find().sort({ createdAt: -1 }).lean();
        // A handful of creators at most: resolve emails in one query rather
        // than per-row.
        const users = yield User_1.User.find({ _id: { $in: pats.map((p) => p.userId) } }).lean();
        const emailOf = new Map(users.map((u) => [u._id.toString(), u.email]));
        const payload = {
            pats: pats.map((p) => {
                var _a;
                return ({
                    id: p._id.toString(),
                    name: p.name,
                    createdAt: p.createdAt.toISOString(),
                    lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
                    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
                    // Null only for a deleted creator — the middleware already refuses
                    // to authenticate such tokens, so this is a display edge case.
                    creatorEmail: (_a = emailOf.get(p.userId.toString())) !== null && _a !== void 0 ? _a : null,
                });
            }),
        };
        res.json(payload);
    }
    catch (_err) {
        res.status(500).json({ message: 'Error loading tokens' });
    }
}));
router.post('/pats', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const parsed = validation_1.createPatSchema.safeParse((_a = req.body) !== null && _a !== void 0 ? _a : {});
    if (!parsed.success) {
        return res.status(400).json({ message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid payload' });
    }
    try {
        // 32 random bytes: the plaintext is shown exactly once in this response,
        // never persisted (only the sha256 digest is) and never logged.
        const token = `tova_pat_${crypto_1.default.randomBytes(32).toString('base64url')}`;
        const tokenHash = crypto_1.default.createHash('sha256').update(token).digest('hex');
        const pat = yield Pat_1.Pat.create({
            name: parsed.data.name,
            tokenHash,
            userId: (_d = req.user) === null || _d === void 0 ? void 0 : _d.id,
        });
        res.status(201).json({
            pat: {
                id: pat._id.toString(),
                name: pat.name,
                token,
                createdAt: pat.createdAt.toISOString(),
            },
        });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error creating token' });
    }
}));
// Revocation (#184): deleting the row makes the very next request with the
// token 401 — the middleware looks the hash up per request.
router.delete('/pats/:id', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const id = String(req.params.id);
    if (!mongoose_1.default.isValidObjectId(id)) {
        return res.status(404).json({ message: 'Token not found' });
    }
    try {
        const result = yield Pat_1.Pat.deleteOne({ _id: id });
        if (result.deletedCount === 0)
            return res.status(404).json({ message: 'Token not found' });
        res.json({ message: 'Token revoked' });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error revoking token' });
    }
}));
exports.default = router;
