"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Pat = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
// Personal access tokens (#184): agent/CLI credentials generated in the
// admin view. Only the sha256 digest is stored — the plaintext token is
// returned exactly once, at creation. Role is never baked in: the auth
// middleware loads the creator's live role on every request, so demoting a
// user demotes their PATs immediately.
const patSchema = new mongoose_1.default.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
    },
    tokenHash: {
        type: String,
        required: true,
    },
    userId: {
        type: mongoose_1.default.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastUsedAt: {
        type: Date,
    },
    // Blank = non-expiring: the .env-paste workflow wants long-lived tokens,
    // so expiry is opt-in rather than a default.
    expiresAt: {
        type: Date,
    },
});
patSchema.index({ tokenHash: 1 }, { unique: true });
exports.Pat = mongoose_1.default.model('Pat', patSchema);
