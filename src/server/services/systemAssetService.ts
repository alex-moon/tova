import { Asset } from '../models/Asset';
import { putObject } from './storageService';
import { MAX_ASSET_SIZE, sanitizeFilename } from './assetLimits';

// Server-side write path for system-generated assets (issue #66): Tova
// itself creates a file (currently markdown only) and puts it in the user's
// asset library alongside uploads. Owned by the requesting user, so list /
// read / delete / attach paths work unchanged; `origin` records provenance.
type CreateSystemAssetResult =
  | { ok: true; fileId: string; filename: string; size: number; createdAt: Date }
  | { ok: false; code: 'invalid' | 'too_large'; message: string };

// The generator emits markdown files only for now (`text/markdown`; the
// alias stays accepted because presign has always allowed it). Widening the
// family (plain text, code execution output) is a one-line change here since
// the full upload allowlist intentionally stays out of this stricter path.
const SYSTEM_ALLOWED_CONTENT_TYPES = new Set(['text/markdown', 'text/x-markdown']);

const fail = (code: 'invalid' | 'too_large', message: string): CreateSystemAssetResult => ({
  ok: false,
  code,
  message,
});

export const createSystemAsset = async (
  userId: string,
  filename: string,
  buffer: Buffer,
  contentType: string,
): Promise<CreateSystemAssetResult> => {
  if (!SYSTEM_ALLOWED_CONTENT_TYPES.has(contentType)) {
    return fail('invalid', `Content type ${contentType} is not allowed for generated files`);
  }
  if (buffer.length === 0) {
    return fail('invalid', 'Generated file is empty');
  }
  if (buffer.length > MAX_ASSET_SIZE) {
    return fail('too_large', 'Generated file is too large (max 15 MB)');
  }

  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    return fail('invalid', 'Generated filename is invalid');
  }

  const asset = await Asset.create({
    userId,
    filename: safeName,
    key: 'pending',
    contentType,
    size: buffer.length,
    status: 'pending',
    origin: 'system-generated',
  });
  const key = `${userId}/${asset._id}/${safeName}`;

  try {
    await putObject(key, buffer, contentType);
  } catch (err) {
    asset.status = 'failed';
    asset.failureReason = 'storage-error';
    await asset.save();
    throw err;
  }

  asset.key = key;
  // The full buffer is the text by construction; no extraction step needed.
  // Per OQ4 the FULL text is stored — the 12k cap applies only at
  // prompt-assembly time (truncateForPrompt there, not here).
  const text = buffer.toString('utf8');
  asset.textExtracted = text || null;
  asset.status = 'ready';
  await asset.save();

  return {
    ok: true,
    fileId: String(asset._id),
    filename: asset.filename,
    size: asset.size,
    createdAt: asset.createdAt as Date,
  };
};
