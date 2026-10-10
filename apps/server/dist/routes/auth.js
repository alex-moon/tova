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
const crypto_1 = __importDefault(require("crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const User_1 = require("../models/User");
const userService_1 = require("../services/userService");
const jwt_1 = require("../config/jwt");
const validation_1 = require("../validation");
const auth_1 = require("../middleware/auth");
const geoLocationService_1 = require("../services/geoLocationService");
const router = express_1.default.Router();
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
// Fetch name/picture from Google's userinfo endpoint. Both fields are
// tolerated-absent (users/orgs may withhold them); invalid values are dropped.
const fetchGoogleProfile = (accessToken) => __awaiter(void 0, void 0, void 0, function* () {
    const res = yield fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        // Never let a stalled userinfo request hang the OAuth callback.
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
        throw new Error(`Userinfo request failed with status ${res.status}`);
    }
    const data = (yield res.json());
    const profile = {};
    if (typeof data.name === 'string' && data.name.trim()) {
        // Bounded to match the User schema maxlength so a hostile payload can
        // never push save() past validation and break login.
        profile.name = data.name.trim().slice(0, 100);
    }
    if (typeof data.picture === 'string' && data.picture.trim()) {
        profile.avatarUrl = data.picture.trim().slice(0, 2048);
    }
    return profile;
});
const getGoogleConfig = () => {
    if (!process.env.GOOGLE_CLIENT_ID ||
        !process.env.GOOGLE_CLIENT_SECRET ||
        !process.env.GOOGLE_CALLBACK_URL) {
        return null;
    }
    return {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: process.env.GOOGLE_CALLBACK_URL,
    };
};
const issueSessionCookie = (user, res) => {
    const token = jsonwebtoken_1.default.sign({ id: user._id, email: user.email, role: user.role }, (0, jwt_1.getJwtSecret)(), {
        expiresIn: '7d',
    });
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        // 'lax' rather than 'strict': Google OAuth returns via a cross-site
        // top-level GET, and 'strict' cookies are not sent on that navigation.
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
};
router.post('/register', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const { email, password } = (_a = req.body) !== null && _a !== void 0 ? _a : {};
        const parsed = validation_1.registerSchema.safeParse({ email, password });
        if (!parsed.success) {
            return res
                .status(400)
                .json({ message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid payload' });
        }
        const registerData = parsed.data;
        const existingUser = yield User_1.User.findOne({ email: registerData.email });
        if (existingUser) {
            return res.status(400).json({ message: 'Email is already registered' });
        }
        const user = new User_1.User({ email: registerData.email, passwordHash: registerData.password });
        yield user.save();
        const userPayload = {
            id: user._id.toString(),
            email: user.email,
            role: user.role,
        };
        issueSessionCookie(user, res);
        res.status(201).json({ user: userPayload });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error creating user' });
    }
}));
router.post('/login', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const { email, password } = (_a = req.body) !== null && _a !== void 0 ? _a : {};
        const parsed = validation_1.loginSchema.safeParse({ email, password });
        if (!parsed.success) {
            return res
                .status(400)
                .json({ message: (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid payload' });
        }
        const loginData = parsed.data;
        const user = yield User_1.User.findOne({ email: loginData.email });
        if (!user || !(yield user.comparePassword(loginData.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        issueSessionCookie(user, res);
        const userPayload = {
            id: user._id.toString(),
            email: user.email,
            role: user.role,
        };
        res.json({ user: userPayload });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error logging in' });
    }
}));
router.get('/google', (req, res) => {
    const config = getGoogleConfig();
    if (!config) {
        return res.status(503).json({ message: 'Google sign-in is not configured' });
    }
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('prompt', 'select_account');
    const state = crypto_1.default.randomBytes(16).toString('hex');
    url.searchParams.set('state', state);
    res.cookie('google_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        // 'lax': the provider redirect back to /callback is a cross-site
        // top-level GET; under 'strict' the state cookie would not be sent.
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000, // 10 minutes
    });
    res.redirect(url.toString());
});
router.get('/google/callback', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const config = getGoogleConfig();
    if (!config) {
        return res.status(503).send('Google sign-in is not configured');
    }
    const code = req.query.code;
    const expectedState = req.cookies.google_state;
    res.clearCookie('google_state');
    const state = req.query.state;
    if (typeof code !== 'string' || !code) {
        return res.status(400).send('Missing authorization code');
    }
    try {
        if (!expectedState ||
            typeof state !== 'string' ||
            state.length !== expectedState.length ||
            !crypto_1.default.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
            return res.status(400).send('Invalid state');
        }
        const tokenRes = yield fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: config.clientId,
                client_secret: config.clientSecret,
                redirect_uri: config.callbackUrl,
                grant_type: 'authorization_code',
            }),
        });
        if (!tokenRes.ok) {
            throw new Error(`Token exchange failed with status ${tokenRes.status}`);
        }
        const body = (yield tokenRes.json());
        if (!body.id_token) {
            throw new Error('Missing id_token in token response');
        }
        const payload = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
        if (!payload.email || payload.email_verified === false) {
            return res.status(401).send('Google account email could not be verified');
        }
        // Profile enrichment is non-fatal: authentication must never break on it.
        // Google's OIDC docs only "might provide" name/picture as id_token claims,
        // so the userinfo endpoint is the reliable source.
        let profile;
        if (body.access_token) {
            try {
                profile = yield fetchGoogleProfile(body.access_token);
            }
            catch (err) {
                console.error('Google userinfo fetch failed:', err);
            }
        }
        const email = payload.email.toLowerCase();
        const user = yield (0, userService_1.resolveOrCreateUser)(email, payload.sub, profile);
        issueSessionCookie(user, res);
        res.redirect('/');
    }
    catch (err) {
        console.error('Google OAuth error:', err);
        res.status(502).send('Error completing Google sign-in');
    }
}));
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
});
// User lookup happens in the handler (verify is the shared middleware) so
// that live role/permission changes are reflected on every read.
router.get('/me', auth_1.authenticate, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const user = yield User_1.User.findById((_a = req.user) === null || _a === void 0 ? void 0 : _a.id);
        if (!user) {
            res.clearCookie('token');
            return res.status(401).json({ message: 'User no longer exists' });
        }
        // Coarse geolocation (#50): resolves at most once per user per week and
        // never throws; fresh or cooldown-suppressed calls return immediately.
        yield (0, geoLocationService_1.ensureUserLocation)(user, req.ip);
        const userPayload = (0, userService_1.toAuthUser)(user);
        res.json({ user: userPayload });
    }
    catch (_err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
}));
exports.default = router;
