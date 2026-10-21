import { Asset } from '../../models/Asset';
import { spacesWorkspaceStorage } from '../workspace/workspaceStorage';
import {
  ALLOWED_CONTENT_TYPES,
  CONFIRM_MAX_AGE_MS,
  MAX_ASSET_SIZE,
  isSafeFilename,
  sanitizeFilename,
} from './assetLimits';
import { safeAsset } from './assetViews';

/* Core of POST /presign and the bulk per-item loop; never throws. */
// @see #68 #396

// Pending rows are TTL-reclaimed at 2h — outliving the 1h confirm window.
const PENDING_TTL_MS = 2 * CONFIRM_MAX_AGE_MS;

// Per-user cap on live pending rows; unconfirmed presigns cannot pool up.
// @see #396
export const MAX_PENDING_ASSETS = 40;

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
  const safeName = sanitizeFilename(filename);
  if (!isSafeFilename(safeName)) {
    return { status: 'rejected', code: 400, message: 'Filename is invalid' };
  }

  const asset = await Asset.create({
    userId,
    filename: safeName,
    key: 'pending',
    contentType,
    size,
    status: 'pending',
    // Presign runs before a session may exist; no truthful session id.
    // @see #252 #144
    provenance: { kind: 'upload' },
    // Ephemeral rows are deleted with their Spaces object after the turn.
    // @see #116
    ...(opts.ephemeral ? { ephemeral: true } : {}),
    // Never-confirmed rows (and their objects) are swept; the TTL index is
    // the backstop.
    // @see #396
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });

  // Counting before the create would race across concurrent presigns and
  // overshoot without bound; create first, then roll this row back if the
  // live pool is over the cap. No object exists yet to clean up.
  // @see #396
  const pending = await Asset.countDocuments({ userId, status: 'pending' });
  if (pending > MAX_PENDING_ASSETS) {
    await Asset.deleteOne({ _id: asset._id, status: 'pending' });
    return {
      status: 'rejected',
      code: 429,
      message: 'Too many pending uploads; confirm or remove existing ones first',
    };
  }

  const key = `${userId}/${asset._id}/${safeName}`;
  asset.key = key;
  await asset.save();

  const uploadUrl = await spacesWorkspaceStorage.presignPutByKey(key, 60, contentType);
  return { status: 'ok', uploadUrl, asset: safeAsset(asset) };
};

// Delete pending rows past the confirm window together with their Spaces
// objects. Row delete first, object only when the row went: a confirm
// winning the race between find and delete keeps both. The TTL index
// covers rows this sweep misses.
// @see #396
export const sweepStalePendingAssets = async (
  maxAgeMs: number = CONFIRM_MAX_AGE_MS,
  limit = 200,
): Promise<number> => {
  const stale = await Asset.find({
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - maxAgeMs) },
  })
    .select('key')
    .limit(limit);
  let swept = 0;
  for (const asset of stale) {
    const removed = await Asset.deleteOne({ _id: asset._id, status: 'pending' });
    if (!removed.deletedCount) continue;
    if (asset.key !== 'pending') {
      await Promise.resolve(spacesWorkspaceStorage.deleteByKey(asset.key)).catch(() => undefined);
    }
    swept += 1;
  }
  return swept;
};

let timer: ReturnType<typeof setInterval> | null = null;
let boot: ReturnType<typeof setTimeout> | null = null;

// Hourly sweep, first pass shortly after boot; version-pruner shape.
// @see #396
export const startPendingAssetSweeper = (): void => {
  if (timer) return;
  boot = setTimeout(() => {
    void sweepStalePendingAssets().catch(() => undefined);
  }, 120_000);
  timer = setInterval(
    () => {
      void sweepStalePendingAssets().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  boot.unref?.();
  timer.unref?.();
};

export const stopPendingAssetSweeper = (): void => {
  if (boot) {
    clearTimeout(boot);
    boot = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

export { presignItemForUser };
export type { PresignItem, PresignResult };
