// Shared asset limits: every path must enforce exactly the same rules.
// @see #66 #69

export const MAX_ASSET_SIZE = 15 * 1024 * 1024;

// Bulk-upload total cap: 20 files x 15 MB nominal per-file cap.
// @see #68
export const MAX_BULK_TOTAL_SIZE = 300 * 1024 * 1024;

// Bulk-download stored-size cap: the real limiter at 15 MB per file.
// @see #69
export const BULK_MAX_TOTAL_SIZE = 500 * 1024 * 1024;

// Presign-time allowlist; the browser PUTs with this same Content-Type.
export const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  // Convertible document formats reach the markdown pipeline.
  // @see #67
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
// 'application/zip' is deliberately absent: never an accepted format.
// @see #68

// Images attach as `image_url` parts; image-ness is content type only.
// @see #115
const IMAGE_CONTENT_TYPES = [...ALLOWED_CONTENT_TYPES].filter((type) => type.startsWith('image/'));

export const isImageContentType = (contentType: string): boolean =>
  IMAGE_CONTENT_TYPES.includes(contentType);

// Presign + confirm headroom: stale pending rows can never be confirmed.
// @see #34 #396
export const CONFIRM_MAX_AGE_MS = 60 * 60 * 1000;

// Filenames become the last key segment: no separators or control chars.
export const sanitizeFilename = (filename: string): string =>
  filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();

// A sanitized name must never be empty or a path-relative dot segment —
// an S3 key ending in `..` escapes the asset prefix.
// @see #396
export const isSafeFilename = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..';
