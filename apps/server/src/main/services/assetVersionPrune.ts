import { AssetVersion } from '../models/AssetVersion';

/* Daily prune of asset versions older than a year where a newer version of the same asset exists; keeps the snapshot store bounded without losing any current-file history. */
// @see #369

const PRUNE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export const pruneOldAssetVersions = async (now: Date = new Date()): Promise<number> => {
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
  // Max live version per asset that still has an old row; only those rows are prunable.
  const stale = await AssetVersion.aggregate<{ _id: string; maxVersion: number }>([
    { $match: { createdAt: { $lt: cutoff } } },
    { $group: { _id: '$assetId', maxVersion: { $max: '$version' } } },
  ]);
  if (stale.length === 0) return 0;
  let deleted = 0;
  for (const entry of stale) {
    const result = await AssetVersion.deleteMany({
      assetId: entry._id,
      version: { $lt: entry.maxVersion },
      createdAt: { $lt: cutoff },
    });
    deleted += result.deletedCount ?? 0;
  }
  return deleted;
};

let timer: ReturnType<typeof setInterval> | null = null;

export const startAssetVersionPruner = (): void => {
  if (timer !== null) return;
  // First sweep shortly after boot, then daily.
  const first = setTimeout(() => {
    void pruneOldAssetVersions().catch(() => {});
  }, 60_000);
  timer = setInterval(
    () => {
      void pruneOldAssetVersions().catch(() => {});
    },
    24 * 60 * 60 * 1000,
  );
  if (typeof first.unref === 'function') first.unref();
};

export const stopAssetVersionPruner = (): void => {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
};
