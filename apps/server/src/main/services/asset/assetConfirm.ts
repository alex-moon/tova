import { Asset, type AssetDocument } from '../../models/Asset';
import { spacesWorkspaceStorage } from '../workspace/workspaceStorage';
import { CONFIRM_MAX_AGE_MS, MAX_ASSET_SIZE, isImageContentType } from './assetLimits';
import { enqueueAssetJob } from './assetJobService';
import { isConvertible } from '../markdownConversion';
import { extractText, isExtractable } from '../textExtraction';
import { safeAsset } from './assetViews';
import { enqueueWorkspaceEmbedding } from '../workspace/workspaceEmbeddingIngest';

// Extraction stays light: only objects up to this size are pulled back.
const MAX_EXTRACT_BYTES = 1_000_000;

/* Shared by POST /:id/confirm and the bulk per-item loop; never throws. */
// @see #68
type ConfirmResult =
  | { status: 'ok'; asset: ReturnType<typeof safeAsset> }
  | { status: 'rejected'; code: number; message: string };

// Failure paths drop the Spaces bytes too: past this point the row is
// unusable and the object would orphan.
// @see #396
const failAsset = async (
  asset: AssetDocument,
  reason: string,
  code: number,
  message: string,
): Promise<{ status: 'rejected'; code: number; message: string }> => {
  asset.status = 'failed';
  asset.failureReason = reason;
  await asset.save();
  if (asset.key !== 'pending') {
    await Promise.resolve(spacesWorkspaceStorage.deleteByKey(asset.key)).catch(() => undefined);
  }
  return { status: 'rejected', code, message };
};

const confirmAsset = async (asset: AssetDocument): Promise<ConfirmResult> => {
  if (asset.status !== 'pending') {
    return { status: 'rejected', code: 409, message: 'Asset was already confirmed' };
  }
  if (Date.now() - new Date(asset.createdAt).getTime() > CONFIRM_MAX_AGE_MS) {
    return failAsset(asset, 'expired', 409, 'Upload window has expired');
  }

  let head;
  try {
    head = await spacesWorkspaceStorage.headByKey(asset.key);
  } catch (err) {
    console.error('Asset confirm HEAD error:', err);
    return failAsset(asset, 'upload-not-found', 409, 'Upload was not found in storage');
  }

  if (head.size <= 0 || head.size > MAX_ASSET_SIZE) {
    return failAsset(asset, 'size', 413, 'Stored file size is invalid');
  }

  asset.size = head.size;
  if (head.contentType) asset.contentType = head.contentType;

  let text: string | null = null;
  if (isExtractable(asset.filename) && head.size <= MAX_EXTRACT_BYTES) {
    const buf = await spacesWorkspaceStorage.getByKey(asset.key, { maxBytes: MAX_EXTRACT_BYTES });
    // Store the FULL text — the 12k cap applies only at prompt-assembly time.
    if (buf) text = extractText(asset.filename, buf);
    if (text !== null) asset.textExtracted = text === '' ? null : text;
  }

  asset.status = 'ready';
  // Confirmed rows live until deleted by their owner; no TTL.
  // @see #396
  asset.expiresAt = undefined;
  // Ephemeral assets never queue work; images queue one conversion+OCR job.
  // @see #116 #67 #208 #209
  const isImage = isImageContentType(asset.contentType);
  const needsConversion = text === null && isConvertible(asset.filename);
  const needsOcr = isImage;
  const needsThumbnail = isImage;
  if ((needsConversion || needsOcr || needsThumbnail) && !asset.ephemeral) {
    if (needsConversion || needsOcr) {
      asset.markdownStatus = 'pending';
      asset.markdownFailureReason = null;
    }
    if (needsThumbnail) {
      asset.thumbnailStatus = 'pending';
      asset.thumbnailKey = null;
    }
    await asset.save();
    // Enqueue is best-effort: revert pending flags on failure.
    try {
      await enqueueAssetJob(asset._id);
    } catch (enqueueErr) {
      console.error('Asset job enqueue error:', enqueueErr);
      const revert: Record<string, string> = {};
      if (needsConversion || needsOcr) revert.markdownStatus = 'none';
      if (needsThumbnail) revert.thumbnailStatus = 'none';
      await Asset.updateOne({ _id: asset._id }, { $set: revert });
      if (needsConversion || needsOcr) asset.markdownStatus = 'none';
      if (needsThumbnail) asset.thumbnailStatus = 'none';
    }
    return { status: 'ok', asset: safeAsset(asset) };
  }
  await asset.save();
  // Embed fast-path text: fire-and-forget, flag-gated, never ephemeral.
  // @see #294
  if (!asset.ephemeral) {
    enqueueWorkspaceEmbedding({
      userId: String(asset.userId),
      kind: 'file',
      sourceId: String(asset._id),
      source: {
        kind: 'file',
        filename: asset.filename,
        markdownExtracted: asset.markdownExtracted,
        textExtracted: asset.textExtracted,
      },
    });
  }
  return { status: 'ok', asset: safeAsset(asset) };
};

export { confirmAsset };
export type { ConfirmResult };
