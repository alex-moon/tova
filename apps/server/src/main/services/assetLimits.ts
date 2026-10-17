// Shared asset limits and normalization: presign/confirm, the system-asset path and bulk caps must enforce exactly the same rules.
// @see #66 #69

export const MAX_ASSET_SIZE = 15 * 1024 * 1024;

// Bulk-upload total cap: 20 files x 15 MB nominal per-file cap.
// @see #68
export const MAX_BULK_TOTAL_SIZE = 300 * 1024 * 1024;

// Bulk-download stored-size cap: the real limiter given the 15 MB per-file presign cap.
// @see #69
export const BULK_MAX_TOTAL_SIZE = 500 * 1024 * 1024;

// Allowlist enforced at presign time; the browser PUTs with this same Content-Type (the presigned URL stores it); the system-asset path reuses it.
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
// 'application/zip' is deliberately absent: zip is never an accepted upload format, and no upload path reads archive contents.
// @see #68

// Images attach as real `image_url` content parts, so "is this an image" is judged by content type, never filename.
// @see #115
const IMAGE_CONTENT_TYPES = [...ALLOWED_CONTENT_TYPES].filter((type) => type.startsWith('image/'));

export const isImageContentType = (contentType: string): boolean =>
  IMAGE_CONTENT_TYPES.includes(contentType);

// Filenames become the last key path segment: no path separators, control chars or whitespace-only names.
export const sanitizeFilename = (filename: string): string =>
  filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
