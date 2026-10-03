import type { AssetJobDocument } from '../models/AssetJob';
import { Asset } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { convertToMarkdown, isConvertible } from './markdownConversion';
import { extractUnits } from './documentUnits';
import { isImageContentType } from './assetLimits';
import { makeThumbnail } from './imageThumbnail';
import { thumbnailKeyFor } from './assetThumbnails';

// Real processor for the asset-job queue (issue #67, extended by #208): a job
// covers whatever the asset still needs. Documents get the extension
// toolchain run and the markdown persisted; images get a bounded thumbnail
// derived and stored alongside the original. Jobs whose asset is gone or
// whose lifecycles have both moved on settle as done without touching
// storage. A single job may cover both (markdown and thumbnail) when both are
// pending.

// Match the asset upload cap (MAX_ASSET_SIZE in services/assetLimits.ts);
// declared
// here instead of imported to keep the route module free of worker deps.
export const MAX_CONVERSION_INPUT_BYTES = 15 * 1024 * 1024;

const processConversion = async (
  asset: NonNullable<Awaited<ReturnType<typeof loadAsset>>>,
): Promise<void> => {
  if (!isConvertible(asset.filename)) {
    throw new Error(`asset is not a convertible type: ${asset.filename}`);
  }

  const buffer = await spacesWorkspaceStorage.getByKey(asset.key, {
    maxBytes: MAX_CONVERSION_INPUT_BYTES,
  });
  if (!buffer) {
    throw new Error('input-not-readable: object missing or too large');
  }

  const markdown = await convertToMarkdown(asset.filename, buffer);
  asset.markdownExtracted = markdown;
  // Issue #159: slice the (already-capped) conversion into per-unit text.
  asset.set('units', extractUnits(asset.filename, markdown));
  asset.markdownStatus = 'ready';
  asset.markdownFailureReason = null;
  await asset.save();
};

const processThumbnail = async (
  asset: NonNullable<Awaited<ReturnType<typeof loadAsset>>>,
): Promise<void> => {
  if (!isImageContentType(asset.contentType)) {
    throw new Error(`asset is not an image: ${asset.contentType}`);
  }

  const buffer = await spacesWorkspaceStorage.getByKey(asset.key, {
    maxBytes: MAX_CONVERSION_INPUT_BYTES,
  });
  if (!buffer) {
    throw new Error('input-not-readable: object missing or too large');
  }

  const thumbnail = await makeThumbnail(buffer);
  const key = thumbnailKeyFor(String(asset.userId), asset._id);
  await spacesWorkspaceStorage.putByKey(key, thumbnail.buffer, 'image/png');
  asset.thumbnailKey = key;
  asset.thumbnailStatus = 'ready';
  await asset.save();
};

const loadAsset = (assetId: AssetJobDocument['assetId']) =>
  Asset.findById(assetId).select(
    'userId filename key contentType status textExtracted markdownExtracted markdownStatus markdownFailureReason thumbnailKey thumbnailStatus size units',
  );

export const processAssetConversionJob = async (job: AssetJobDocument): Promise<void> => {
  const asset = await loadAsset(job.assetId);
  if (!asset || asset.status !== 'ready') return;

  const needsConversion = asset.markdownStatus === 'pending';
  const needsThumbnail = asset.thumbnailStatus === 'pending';
  if (!needsConversion && !needsThumbnail) return;

  if (needsConversion) await processConversion(asset);
  if (needsThumbnail) await processThumbnail(asset);
};
