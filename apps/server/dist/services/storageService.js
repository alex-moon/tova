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
exports.listObjectKeys = exports.deleteObject = exports.getObjectBuffer = exports.getObjectStream = exports.headObject = exports.presignGetUrl = exports.putObject = exports.presignPutUrl = exports.isStorageConfigured = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const config_1 = require("../config");
// DigitalOcean Spaces is S3-compatible; AWS SDK v3 against a Spaces endpoint
// is the standard integration (issue #34). Feature-gated like
// webSearchService: when the env vars are absent, isStorageConfigured()
// returns false and callers degrade gracefully instead of crashing.
// Read lazily (not as module constants): env may be loaded after module
// import in some entrypoints, and tests mutate env directly.
const bucket = () => config_1.config.storage.bucket;
let client = null;
const isStorageConfigured = () => Boolean(config_1.config.storage.key && config_1.config.storage.secret && bucket());
exports.isStorageConfigured = isStorageConfigured;
const getClient = () => {
    if (!(0, exports.isStorageConfigured)()) {
        throw new Error('Spaces storage is not configured (DO_SPACES_* env vars missing)');
    }
    if (!client) {
        client = new client_s3_1.S3Client({
            // Region confirmed lon1 against a real ListObjectsV2 call (open
            // question 3 in the plan is resolved; env override kept for the live
            // host to be decisive).
            endpoint: `https://${config_1.config.storage.region}.digitaloceanspaces.com`,
            region: config_1.config.storage.region,
            credentials: {
                accessKeyId: config_1.config.storage.key,
                secretAccessKey: config_1.config.storage.secret,
            },
        });
    }
    return client;
};
const presignPutUrl = (key_1, ...args_1) => __awaiter(void 0, [key_1, ...args_1], void 0, function* (key, expiresIn = 60, contentType) {
    return (0, s3_request_presigner_1.getSignedUrl)(getClient(), new client_s3_1.PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn });
});
exports.presignPutUrl = presignPutUrl;
// Direct server-side PUT (issue #66): system-generated files are written by
// the server itself, so no presigned-URL round-trip is needed. Throws on
// failure like the other direct commands.
const putObject = (key, body, contentType) => __awaiter(void 0, void 0, void 0, function* () {
    yield getClient().send(new client_s3_1.PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, Body: body }));
});
exports.putObject = putObject;
const presignGetUrl = (key_1, ...args_1) => __awaiter(void 0, [key_1, ...args_1], void 0, function* (key, expiresIn = 300) { return (0, s3_request_presigner_1.getSignedUrl)(getClient(), new client_s3_1.GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn }); });
exports.presignGetUrl = presignGetUrl;
const headObject = (key) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const result = yield getClient().send(new client_s3_1.HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: (_a = result.ContentLength) !== null && _a !== void 0 ? _a : 0, contentType: result.ContentType };
});
exports.headObject = headObject;
// Streams an object back for server-side piping (e.g. #69 bulk zip
// download). Unlike getObjectBuffer there is no size cap: callers decide
// what is safe to stream. Returns the raw Body stream.
const getObjectStream = (key) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const result = yield getClient().send(new client_s3_1.GetObjectCommand({ Bucket: bucket(), Key: key }));
    return ((_a = result.Body) !== null && _a !== void 0 ? _a : null);
});
exports.getObjectStream = getObjectStream;
// Buffers an object for light text extraction at confirm time (issue #34).
// Objects larger than maxBytes are not downloaded (extraction stays light);
// null means "either too big to pull or no body" and callers treat it as no
// text extracted rather than an error.
const getObjectBuffer = (key_1, ...args_1) => __awaiter(void 0, [key_1, ...args_1], void 0, function* (key, maxBytes = 1000000) {
    var _a, _b, _c, _d, _e;
    const result = yield getClient().send(new client_s3_1.GetObjectCommand({ Bucket: bucket(), Key: key }));
    if (((_a = result.ContentLength) !== null && _a !== void 0 ? _a : 0) > maxBytes) {
        (_c = (_b = result.Body) === null || _b === void 0 ? void 0 : _b.destroy) === null || _c === void 0 ? void 0 : _c.call(_b);
        return null;
    }
    const bytes = yield ((_e = (_d = result.Body) === null || _d === void 0 ? void 0 : _d.transformToByteArray) === null || _e === void 0 ? void 0 : _e.call(_d));
    return bytes ? Buffer.from(bytes) : null;
});
exports.getObjectBuffer = getObjectBuffer;
// Returns true on success (NoSuchKey / NotFound converge to true); deletes
// are idempotent from callers' perspective.
const deleteObject = (key) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield getClient().send(new client_s3_1.DeleteObjectCommand({ Bucket: bucket(), Key: key }));
        return true;
    }
    catch (err) {
        const name = err === null || err === void 0 ? void 0 : err.name;
        if (name === 'NoSuchKey' || name === 'NotFound')
            return true;
        throw err;
    }
});
exports.deleteObject = deleteObject;
// All keys under one prefix (issue #143: prefix sweeps for the factory
// reset). Paginates with ListObjectsV2 continuation tokens; up to 1000 keys
// per page. Listing is only possible with real credentials, so callers gate
// on isStorageConfigured() first.
const listObjectKeys = (prefix) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const keys = [];
    let continuation;
    do {
        const result = yield getClient().send(new client_s3_1.ListObjectsV2Command({
            Bucket: bucket(),
            Prefix: prefix,
            ContinuationToken: continuation,
        }));
        for (const object of (_a = result.Contents) !== null && _a !== void 0 ? _a : [])
            if (object.Key)
                keys.push(object.Key);
        continuation = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuation);
    return keys;
});
exports.listObjectKeys = listObjectKeys;
