import { AssetVersion } from '../../models/AssetVersion';

/* Daily prune of versions older than a year with a newer version left. */
// @see #369

const PRUNE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export const pruneOldAssetVersions = async (now: Date = new Date()): Promise<number> => {
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
  // Max live version per asset with an old row; only those are prunable.
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
let boot: ReturnType<typeof setTimeout> | null = null;

export const startAssetVersionPruner = (): void => {
  if (timer !== null) return;
  // First sweep shortly after boot, then daily.
  boot = setTimeout(() => {
    void pruneOldAssetVersions().catch(() => {});
  }, 60_000);
  timer = setInterval(
    () => {
      void pruneOldAssetVersions().catch(() => {});
    },
    24 * 60 * 60 * 1000,
  );
  if (typeof boot.unref === 'function') boot.unref();
  if (typeof timer.unref === 'function') timer.unref();
};

export const stopAssetVersionPruner = (): void => {
  if (boot !== null) {
    clearTimeout(boot);
    boot = null;
  }
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
};
