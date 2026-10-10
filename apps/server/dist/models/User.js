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
exports.User = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const userSchema = new mongoose_1.default.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
    },
    passwordHash: {
        type: String,
        required: true,
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',
    },
    googleId: {
        type: String,
        default: null,
    },
    permissions: {
        type: [String],
        default: [],
    },
    // Profile fields (issue #35). `name` and `avatarUrl` are optional: only
    // present once populated (Google login or PATCH /api/profile).
    name: {
        type: String,
        trim: true,
        maxlength: 100,
        default: null,
    },
    avatarUrl: {
        type: String,
        default: null,
    },
    // User-owned (never written by Google); set only via PATCH /api/profile.
    preferredName: {
        type: String,
        trim: true,
        maxlength: 20,
        default: null,
    },
    // Per-user settings; created lazily on first write (no backfill needed).
    settings: {
        type: new mongoose_1.default.Schema({
            customInstructions: {
                type: String,
                maxlength: 4000,
                default: null,
            },
            // Theme preference (issue #53): null = no explicit choice, the
            // client follows prefers-color-scheme then light.
            theme: {
                type: String,
                enum: ['light', 'dark'],
                default: null,
            },
            // Startup-chat preference (issue #96): null = no explicit choice;
            // the client starts from the most recent chat then.
            startupChat: {
                type: String,
                enum: ['recent', 'new'],
                default: null,
            },
            // Zero-data-retention preference (issue #116): when true, chat
            // turns and file attachments made in chat are never persisted to
            // Mongo/S3; Assets-page uploads are unaffected. Forward-looking
            // only: it stops new writes and does not purge pre-existing data.
            zdr: {
                type: Boolean,
                default: false,
            },
            // Delete-confirmation preferences (issue #59): only `false` is ever
            // written explicitly ("Always" or a Profile toggle); absent keys
            // default to true, so legacy docs need no backfill.
            confirmDeletes: {
                type: new mongoose_1.default.Schema({
                    chat: { type: Boolean, default: true },
                    file: { type: Boolean, default: true },
                }, { _id: false }),
                default: null,
            },
        }, { _id: false }),
        default: null,
    },
    // Coarse country-level geolocation (issue #50), resolved server-side from
    // the request IP. Absent = unresolved; only country/countryCode and the
    // resolution timestamp are ever stored — no city or lat/lon data.
    location: {
        type: new mongoose_1.default.Schema({
            country: { type: String, maxlength: 100 },
            countryCode: { type: String, uppercase: true, maxlength: 2 },
            resolvedAt: { type: Date },
        }, { _id: false }),
        default: null,
    },
}, {
    timestamps: true,
});
// Hash password before saving
userSchema.pre('save', function () {
    return __awaiter(this, void 0, void 0, function* () {
        if (!this.isModified('passwordHash'))
            return;
        try {
            const salt = yield bcryptjs_1.default.genSalt(10);
            this.passwordHash = yield bcryptjs_1.default.hash(this.passwordHash, salt);
        }
        catch (err) {
            throw err;
        }
    });
});
// Method to check password
userSchema.methods.comparePassword = function (password) {
    return __awaiter(this, void 0, void 0, function* () {
        return bcryptjs_1.default.compare(password, this.passwordHash);
    });
};
exports.User = mongoose_1.default.model('User', userSchema);
