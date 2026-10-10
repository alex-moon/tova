"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMongoUri = void 0;
// Two connection paths (issue #138): MONGODB_URL takes precedence when set and
// is returned verbatim — never re-parsed or reassembled — so a spec-accurate
// Atlas `mongodb+srv://...` URL (or any full URL, credential and options
// included) passes through untouched; the dbName argument does not apply to
// it, since the URL carries its own database. When MONGODB_URL is unset,
// the dev fallback assembles a URI from MONGODB_HOST/MONGODB_PASSWORD for the
// plain-Mongo docker compose stack (authSource=admin against the local image).
const buildMongoUri = (dbName, host, password) => {
    var _a, _b;
    if (host === void 0) { host = (_a = process.env.MONGODB_HOST) !== null && _a !== void 0 ? _a : 'localhost'; }
    if (password === void 0) { password = process.env.MONGODB_PASSWORD; }
    const url = (_b = process.env.MONGODB_URL) === null || _b === void 0 ? void 0 : _b.trim();
    if (url)
        return url;
    return `mongodb://tova:${password}@${host}/${encodeURIComponent(dbName !== null && dbName !== void 0 ? dbName : 'tova')}?authSource=admin`;
};
exports.buildMongoUri = buildMongoUri;
