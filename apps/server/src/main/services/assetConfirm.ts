import { Asset, type AssetDocument } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE, isImageContentType } from './assetLimits';
import { enqueueAssetJob } from './assetJobService';
import { isConvertible } from './markdownConversion';
import { extractText, isExtractable } from './textExtraction';
import { safeAsset } from './assetViews';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

// Presign + confirm headroom: stale pending rows can never be confirmed.
// @see #34
const CONFIRM_MAX_AGE_MS = 60 * 60 * 1000;

// Extraction stays light: only objects up to this size are pulled back.
const MAX_EXTRACT_BYTES = 1_000_000;

/* Shared by POST /:id/confirm and the bulk per-item loop; never throws. */
// @see #68
type ConfirmResult =
  | { status: 'ok'; asset: ReturnType<typeof safeAsset> }
  | { status: 'rejected'; code: number; message: string };

const confirmAsset = async (asset: AssetDocument): Promise<ConfirmResult> => {
  if (asset.status !== 'pending') {
    return { status: 'rejected', code: 409, message: 'Asset was already confirmed' };
  }
  if (Date.now() - new Date(asset.createdAt).getTime() > CONFIRM_MAX_AGE_MS) {
    asset.status = 'failed';
    asset.failureReason = 'expired';
    await asset.save();
    return { status: 'rejected', code: 409, message: 'Upload window has expired' };
  }

  let head;
  try {
    head = await spacesWorkspaceStorage.headByKey(asset.key);
  } catch (err) {
    console.error('Asset confirm HEAD error:', err);
    asset.status = 'failed';
    asset.failureReason = 'upload-not-found';
    await asset.save();
    return { status: 'rejected', code: 409, message: 'Upload was not found in storage' };
  }

  if (head.size <= 0 || head.size > MAX_ASSET_SIZE) {
    asset.status = 'failed';
    asset.failureReason = 'size';
    await asset.save();
    return { status: 'rejected', code: 413, message: 'Stored file size is invalid' };
  }

  asset.size = head.size;
  if (head.contentType) asset.contentType = head.contentType;

  let text: string | null = null;
  if (isExtractable(asset.filename) && head.size <= MAX_EXTRACT_BYTES) {
    const buf = await spacesWorkspaceStorage.getByKey(asset.key);
    // Store the FULL text — the 12k cap applies only at prompt-assembly time.
    if (buf) text = extractText(asset.filename, buf);
    if (text !== null) asset.textExtracted = text === '' ? null : text;
  }

  asset.status = 'ready';
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
