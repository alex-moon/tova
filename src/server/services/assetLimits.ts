// Shared asset limits and normalization (issue #66): the presign/confirm
// route and the new system-asset write path must enforce exactly the same
// cap, allowlist and filename rules, so they live here instead of inline in
// routes/assets.ts.

export const MAX_ASSET_SIZE = 15 * 1024 * 1024;

// Allowlist enforced at presign time; the browser PUTs with this same
// Content-Type because the presigned URL stores it (Spaces rejects a PUT
// whose Content-Type doesn't match the signature). The system-asset write
// path reuses it so generated files can never be of a type an upload could
// not be.
export const ALLOWED_CONTENT_TYPES = new Set([
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

// Filenames become the last path segment of the object key: no path
// separators, control chars or whitespace-only names.
// Issue #115: images attach as real `image_url` content parts on the turn,
// so "is this asset an image" is judged by content type (never filename).
// The image branches of the allowlist above are exactly these.
const IMAGE_CONTENT_TYPES = [...ALLOWED_CONTENT_TYPES].filter((type) => type.startsWith('image/'));

export const isImageContentType = (contentType: string): boolean =>
  IMAGE_CONTENT_TYPES.includes(contentType);

// Filenames become the last path segment of the object key: no path
// separators, control chars or whitespace-only names.
export const sanitizeFilename = (filename: string): string =>
  filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
