"use strict";
// Shared asset limits and normalization (issue #66): the presign/confirm
// logic and the new system-asset write path must enforce exactly the same
// cap, allowlist and filename rules, so they live here instead of inline in
// the route/service files. Bulk-download caps (issue #69) live here too.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeFilename = exports.isImageContentType = exports.ALLOWED_CONTENT_TYPES = exports.BULK_MAX_TOTAL_SIZE = exports.MAX_BULK_TOTAL_SIZE = exports.MAX_ASSET_SIZE = void 0;
exports.MAX_ASSET_SIZE = 15 * 1024 * 1024;
// Bulk-upload total cap (#68): 20 files x 15 MB nominal per-file cap; the
// bulk-presign schema rejects requests whose declared sizes exceed it.
exports.MAX_BULK_TOTAL_SIZE = 300 * 1024 * 1024;
// Bulk-download stored-size cap (#69): the file count comes from the query
// schema cap; the stored-size cap is the real limiter given the 15 MB
// per-file presign cap.
exports.BULK_MAX_TOTAL_SIZE = 500 * 1024 * 1024;
// Allowlist enforced at presign time; the browser PUTs with this same
// Content-Type because the presigned URL stores it (Spaces rejects a PUT
// whose Content-Type doesn't match the signature). The system-asset write
// path reuses it so generated files can never be of a type an upload could
// not be.
exports.ALLOWED_CONTENT_TYPES = new Set([
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'text/csv',
    'application/json',
    'application/pdf',
    // Issue #67: convertible document formats reach the markdown pipeline.
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/html',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);
//   'application/zip' is deliberately absent: zip is never an accepted upload
//   format (issue #68 hard rule) — uploads are direct browser→Spaces PUTs of
//   single files, and no upload path ever reads archive contents.
// Issue #115: images attach as real `image_url` content parts on the turn,
// so "is this asset an image" is judged by content type (never filename).
// The image branches of the allowlist above are exactly these.
const IMAGE_CONTENT_TYPES = [...exports.ALLOWED_CONTENT_TYPES].filter((type) => type.startsWith('image/'));
const isImageContentType = (contentType) => IMAGE_CONTENT_TYPES.includes(contentType);
exports.isImageContentType = isImageContentType;
// Filenames become the last path segment of the object key: no path
// separators, control chars or whitespace-only names.
const sanitizeFilename = (filename) => filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
exports.sanitizeFilename = sanitizeFilename;
