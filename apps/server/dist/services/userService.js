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
exports.resolveOrCreateUser = exports.hasPermission = exports.ROUTING_PERMISSION = exports.toAuthUser = void 0;
const crypto_1 = __importDefault(require("crypto"));
const User_1 = require("../models/User");
// Single projection from a user document to the GET /api/auth/me wire shape.
// Shared with PATCH /api/profile so the two endpoints cannot drift (issue #35).
const toAuthUser = (user) => {
    var _a, _b, _c, _d, _e, _f;
    const payload = {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        permissions: user.permissions,
    };
    if (user.name)
        payload.name = user.name;
    if (user.avatarUrl)
        payload.avatarUrl = user.avatarUrl;
    if (user.preferredName)
        payload.preferredName = user.preferredName;
    if ((_a = user.settings) === null || _a === void 0 ? void 0 : _a.customInstructions)
        payload.customInstructions = user.settings.customInstructions;
    if ((_b = user.settings) === null || _b === void 0 ? void 0 : _b.theme)
        payload.theme = user.settings.theme;
    if ((_c = user.settings) === null || _c === void 0 ? void 0 : _c.startupChat)
        payload.startupChat = user.settings.startupChat;
    if ((_d = user.settings) === null || _d === void 0 ? void 0 : _d.zdr) {
        payload.zdr = user.settings.zdr;
        // 'Incognito by default' (#144) reads the same storage slot; the two
        // wire names are aliases of one flag, exposed in lockstep.
        payload.incognitoByDefault = user.settings.zdr;
    }
    if ((_e = user.settings) === null || _e === void 0 ? void 0 : _e.confirmDeletes)
        payload.confirmDeletes = user.settings.confirmDeletes;
    // Country-level geolocation (#50) rides only once resolved; no timestamp
    // is exposed — route consumers never need it and the "remove my location"
    // follow-up can pick it up if it turns out to want it.
    if (((_f = user.location) === null || _f === void 0 ? void 0 : _f.country) && user.location.countryCode)
        payload.location = {
            country: user.location.country,
            countryCode: user.location.countryCode,
        };
    return payload;
};
exports.toAuthUser = toAuthUser;
exports.ROUTING_PERMISSION = 'routing';
const hasPermission = (userId, permission) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const user = yield User_1.User.findById(userId, 'permissions');
    return Boolean((_a = user === null || user === void 0 ? void 0 : user.permissions) === null || _a === void 0 ? void 0 : _a.includes(permission));
});
exports.hasPermission = hasPermission;
// Resolve a user by email: existing emails resolve to that user (linking the
// Google identity if provided); otherwise a new user is created. New users do
// not get any permissions, so they cannot use the model router until granted.
// `profile` (Google-owned name/avatar) is stored on create and overwritten on
// refresh; user-owned fields (preferredName, settings) are never touched here.
const resolveOrCreateUser = (email, googleId, profile) => __awaiter(void 0, void 0, void 0, function* () {
    const user = yield User_1.User.findOne({ email });
    if (user) {
        if (googleId && !user.googleId) {
            user.googleId = googleId;
        }
        if (profile) {
            if (profile.name !== undefined)
                user.name = profile.name;
            if (profile.avatarUrl !== undefined)
                user.avatarUrl = profile.avatarUrl;
        }
        if (user.isModified()) {
            yield user.save();
        }
        return user;
    }
    const passwordHash = crypto_1.default.randomBytes(32).toString('hex');
    const created = yield User_1.User.create(Object.assign(Object.assign(Object.assign(Object.assign({ email,
        passwordHash, role: 'user' }, (googleId ? { googleId } : {})), ((profile === null || profile === void 0 ? void 0 : profile.name) ? { name: profile.name } : {})), ((profile === null || profile === void 0 ? void 0 : profile.avatarUrl) ? { avatarUrl: profile.avatarUrl } : {})), { permissions: [] }));
    return created;
});
exports.resolveOrCreateUser = resolveOrCreateUser;
