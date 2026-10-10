import { Asset } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { ALLOWED_CONTENT_TYPES, MAX_ASSET_SIZE, sanitizeFilename } from './assetLimits';
import { safeAsset } from './assetViews';

// Core of POST /presign (and, per #68, of the bulk presign per-item loop):
// policy checks (type allowlist, size cap), then mint a pending Asset row and
// presign its direct-to-Spaces PUT URL. Returns a typed rejection instead of
// throwing so bulk can map one bad file to a per-item row without blocking
// its siblings; the single route maps the same shape to a status code.
type PresignItem = { filename: string; contentType: string; size: number };
type PresignResult =
  | { status: 'ok'; uploadUrl: string; asset: ReturnType<typeof safeAsset> }
  | { status: 'rejected'; code: number; message: string };

const presignItemForUser = async (
  userId: string,
  { filename, contentType, size }: PresignItem,
  opts: { ephemeral?: boolean } = {},
): Promise<PresignResult> => {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { status: 'rejected', code: 400, message: 'File type is not allowed' };
  }
  if (size > MAX_ASSET_SIZE) {
    return { status: 'rejected', code: 413, message: 'File is too large (max 15 MB)' };
  }

  const asset = await Asset.create({
    userId,
    filename: sanitizeFilename(filename),
    key: 'pending',
    contentType,
    size,
    status: 'pending',
    // ZDR chat attachments (#116): an ephemeral row is deleted together with
    // its Spaces object once the turn that consumes it completes.
    ...(opts.ephemeral ? { ephemeral: true } : {}),
  });

  const key = `${userId}/${asset._id}/${sanitizeFilename(filename)}`;
  asset.key = key;
  await asset.save();

  const uploadUrl = await spacesWorkspaceStorage.presignPutByKey(key, 60, contentType);
  return { status: 'ok', uploadUrl, asset: safeAsset(asset) };
};

export { presignItemForUser };
export type { PresignItem, PresignResult };
