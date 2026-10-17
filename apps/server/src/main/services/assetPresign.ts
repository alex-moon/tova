import { Asset } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { ALLOWED_CONTENT_TYPES, MAX_ASSET_SIZE, sanitizeFilename } from './assetLimits';
import { safeAsset } from './assetViews';

/* Core of POST /presign and the bulk per-item loop: policy checks, then mint a pending Asset row and presign its direct PUT; typed rejection so bulk maps per-item outcomes. */
// @see #68
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
    // Every upload is `kind: 'upload'`: presign runs before a session may exist, so there is no truthful session id to record (absent = unknown, never faked).
    // @see #252 #144
    provenance: { kind: 'upload' },
    // An ephemeral row is deleted with its Spaces object once the consuming turn completes.
    // @see #116
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
