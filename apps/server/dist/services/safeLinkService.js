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
exports.assertSafeUrl = exports.checkUrl = exports.isCheckerEnabled = exports.safeBrowsingApiKey = void 0;
const logRedaction_1 = require("./logRedaction");
const SafeBrowsingCache_1 = require("../models/SafeBrowsingCache");
// Safe Browsing link checker for `fetch_url` (issue #120): every URL the
// agent fetches (including redirect-hop targets) is screened against
// Google's threatMatches endpoint before a request is made. Uses the SAME
// global fetch as everything else, so tests can stub it.
//
// Key read order: GOOGLE_SAFE_BROWSING_API_KEY, falling back to generic
// GOOGLE_API_KEY (which name the user's provisioned key lands under is not
// yet fixed; supporting both is free). Both absent → checker disabled:
// fetch_url proceeds unchanged, mirroring the BRAVE_SEARCH_API_KEY
// precedent (#16).
//
// Failure posture: API errors fail OPEN (proceed) but loudly — a checker
// outage must not brick fetch_url. This is the plan's named, deliberate
// call; switching to fail-closed is a one-line change if the user prefers
// strictness.
const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
// Hard cap so a hung Google call cannot stall a fetch.
const CHECK_TIMEOUT_MS = 4000;
const THREAT_TYPES = [
    'MALWARE',
    'SOCIAL_ENGINEERING',
    'UNWANTED_SOFTWARE',
    'POTENTIALLY_HARMFUL_APPLICATION',
];
const safeBrowsingApiKey = () => process.env.GOOGLE_SAFE_BROWSING_API_KEY || process.env.GOOGLE_API_KEY || undefined;
exports.safeBrowsingApiKey = safeBrowsingApiKey;
const isCheckerEnabled = () => (0, exports.safeBrowsingApiKey)() !== undefined;
exports.isCheckerEnabled = isCheckerEnabled;
const warnOutage = (url, err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('Safe Browsing check failed for %s, proceeding (fail-open): %O', (0, logRedaction_1.redactForLog)(url), (0, logRedaction_1.redactForLog)(message));
};
const callThreatMatches = (url, apiKey) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const response = yield fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client: { clientId: 'tova-agent', clientVersion: '1.0.0' },
            threatInfo: {
                threatTypes: THREAT_TYPES,
                platformTypes: ['ANY_PLATFORM'],
                threatEntryTypes: ['URL'],
                threatEntries: [{ url }],
            },
        }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`Safe Browsing HTTP ${response.status}`);
    const data = (yield response.json());
    return ((_a = data.matches) !== null && _a !== void 0 ? _a : []).flatMap((m) => typeof m.threatType === 'string' ? [m.threatType] : []);
});
const cacheKey = (url) => {
    try {
        return new URL(url).hostname;
    }
    catch (_a) {
        return null;
    }
};
// A cache-read failure is recoverable: fall through to the live API call
// instead of reporting the URL unchecked.
const readCache = (host) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const entry = yield SafeBrowsingCache_1.SafeBrowsingCache.findOne({ host }).lean();
        return (_a = entry === null || entry === void 0 ? void 0 : entry.verdict) !== null && _a !== void 0 ? _a : null;
    }
    catch (err) {
        warnOutage(`cache read for ${host}`, err);
        return null;
    }
});
const writeCache = (host, verdict) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield SafeBrowsingCache_1.SafeBrowsingCache.updateOne({ host }, { verdict, checkedAt: new Date() }, { upsert: true });
    }
    catch (err) {
        warnOutage(`cache write for ${host}`, err);
    }
});
// Screens a URL. Never throws: only API-call errors report safe=true with
// source='unchecked' (fail-open); a Mongo cache failure is degraded to
// losing the cache — the authoritative API verdict is still enforced, so a
// database outage can never green-light a URL Google flagged.
// Returns { enabled: false } when no key is configured — callers proceed.
const checkUrl = (url) => __awaiter(void 0, void 0, void 0, function* () {
    const apiKey = (0, exports.safeBrowsingApiKey)();
    if (!apiKey)
        return { enabled: false, safe: true, source: 'disabled' };
    const host = cacheKey(url);
    if (host) {
        const verdict = yield readCache(host);
        if (verdict === 'unsafe')
            return { enabled: true, safe: false, source: 'cache' };
        if (verdict === 'safe')
            return { enabled: true, safe: true, source: 'cache' };
    }
    try {
        const threats = yield callThreatMatches(url, apiKey);
        if (host)
            yield writeCache(host, threats.length > 0 ? 'unsafe' : 'safe');
        if (threats.length > 0) {
            return { enabled: true, safe: false, source: 'api', threats };
        }
        return { enabled: true, safe: true, source: 'api' };
    }
    catch (err) {
        warnOutage(url, err);
        return { enabled: true, safe: true, source: 'unchecked' };
    }
});
exports.checkUrl = checkUrl;
// Throws a caller-renderable error when the URL is known-unsafe; a no-op
// when the checker is disabled or the verdict is safe/unchecked.
const assertSafeUrl = (url) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const verdict = yield (0, exports.checkUrl)(url);
    if (!verdict.enabled || verdict.safe)
        return;
    const threats = ((_a = verdict.threats) === null || _a === void 0 ? void 0 : _a.length) ? ` (${verdict.threats.join(', ')})` : '';
    throw new Error(`link blocked by Safe Browsing: ${url} reports ${verdict.source} verdict${threats}`);
});
exports.assertSafeUrl = assertSafeUrl;
