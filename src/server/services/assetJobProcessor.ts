import type { AssetJobDocument } from '../models/AssetJob';
import { Asset } from '../models/Asset';
import { getObjectBuffer } from './storageService';
import { convertToMarkdown, isConvertible } from './markdownConversion';

// Real processor for the conversion queue (issue #67): fetch the object with
// a raised buffer cap (the fast-path 1 MB extract cap is a confirm-time
// concern; conversion may fetch up to the 15 MB asset cap), run the
// extension toolchain, and persist the markdown. Jobs whose asset is gone or
// no longer 'pending' settle as done without touching storage.

// Match the asset upload cap (MAX_ASSET_SIZE in routes/assets.ts); declared
// here instead of imported to keep the route module free of worker deps.
export const MAX_CONVERSION_INPUT_BYTES = 15 * 1024 * 1024;

export const processAssetConversionJob = async (job: AssetJobDocument): Promise<void> => {
  const asset = await Asset.findById(job.assetId).select(
    'filename key status markdownExtracted markdownStatus markdownFailureReason size',
  );
  // Asset deleted, already converted, or the lifecycle moved on (e.g. manual
  // retry): the job has nothing to do.
  if (!asset || asset.status !== 'ready' || asset.markdownStatus !== 'pending') return;
  if (!isConvertible(asset.filename)) {
    throw new Error(`asset is not a convertible type: ${asset.filename}`);
  }

  const buffer = await getObjectBuffer(asset.key, MAX_CONVERSION_INPUT_BYTES);
  if (!buffer) {
    throw new Error('input-not-readable: object missing or too large');
  }

  const markdown = await convertToMarkdown(asset.filename, buffer);
  asset.markdownExtracted = markdown;
  asset.markdownStatus = 'ready';
  asset.markdownFailureReason = null;
  await asset.save();
};
