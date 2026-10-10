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
exports.authenticateBearerOrSession = exports.requireRole = exports.authenticate = void 0;
const crypto_1 = __importDefault(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jwt_1 = require("../config/jwt");
const Pat_1 = require("../models/Pat");
const User_1 = require("../models/User");
const authenticate = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, (0, jwt_1.getJwtSecret)());
        req.user = decoded;
        next();
    }
    catch (_err) {
        res.clearCookie('token');
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
};
exports.authenticate = authenticate;
const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Forbidden' });
    }
    next();
};
exports.requireRole = requireRole;
// PAT bearer auth for admin routes (#184). An Authorization header opts in
// to token auth and must carry a valid, unexpired, unrevoked PAT; without
// one the cookie session flow applies unchanged. The creator's role is
// loaded live on every request (never baked into the token), so demoting a
// user demotes their PATs immediately. Every failure mode answers with the
// same 401 message — no oracle for whether a hash exists.
const authenticateBearerOrSession = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    const header = req.headers.authorization;
    if (!header)
        return (0, exports.authenticate)(req, res, next);
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const reject = () => res.status(401).json({ message: 'Invalid or expired token' });
    if (!token)
        return reject();
    try {
        const tokenHash = crypto_1.default.createHash('sha256').update(token).digest('hex');
        const pat = yield Pat_1.Pat.findOne({ tokenHash });
        if (!pat || (pat.expiresAt && pat.expiresAt.getTime() <= Date.now()))
            return reject();
        const creator = yield User_1.User.findById(pat.userId);
        if (!creator)
            return reject();
        req.user = { id: creator._id.toString(), email: creator.email, role: creator.role };
        // Usage stamp for the Access tab: diagnostics only, never worth
        // failing or slowing a request over.
        pat.updateOne({ lastUsedAt: new Date() }).catch(() => { });
        next();
    }
    catch (_err) {
        res.status(500).json({ message: 'Error authenticating token' });
    }
});
exports.authenticateBearerOrSession = authenticateBearerOrSession;
