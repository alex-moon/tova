import { Asset, type AssetDocument } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE, isImageContentType } from './assetLimits';
import { enqueueAssetJob } from './assetJobService';
import { isConvertible } from './markdownConversion';
import { extractText, isExtractable } from './textExtraction';
import { safeAsset } from './assetViews';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

// Presign + confirm headroom: pending assets older than this cannot be
// confirmed, so stale rows never revive (plan honest-boundaries for #34).
const CONFIRM_MAX_AGE_MS = 60 * 60 * 1000;

// Extraction stays light: only objects up to this size are pulled back.
const MAX_EXTRACT_BYTES = 1_000_000;

// Core of POST /:id/confirm (and, per #68, of the bulk confirm per-item
// loop): assumes the asset row is already known to belong to the caller —
// ownership is the caller's lookup (a foreign id must read as "not found",
// never as an error row). Returns a typed rejection instead of throwing so
// bulk can map per-item outcomes; the single route maps the same shape to a
// status code.
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
    // Store the full extracted text (OQ4): the 12k cap applies at prompt-assembly
    // time (truncateForPrompt in the attach envelope / read_file), never here — so
    // a long document is recoverable via read_file instead of being lost at ingest.
    if (buf) text = extractText(asset.filename, buf);
    if (text !== null) asset.textExtracted = text === '' ? null : text;
  }

  asset.status = 'ready';
  // Ephemeral assets (#116) never queue work: the job would keep derived
  // objects alive in storage after the turn deletes the row and bytes.
  // Fast-path extraction already covers the turn's prompt needs.
  // Issue #67: fast-path extraction won, nothing to convert. Otherwise queue
  // a background conversion job — the response latency of /confirm stays low,
  // conversion retries under the job cap, and a failed conversion never fails
  // the asset (the binary is fine).
  // Issue #208: images additionally queue a thumbnail job so the /assets
  // viewer never loads the original; the two pending lifecycles share one job.
  // Issue #209: images also queue OCR, so they now drive the markdown
  // lifecycle too (the processor branches on image content type before the
  // convertible guard).
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
    // Enqueue is best-effort: the asset is confirmed and the binary is
    // fine, so a failed enqueue must not 500 the confirm. Reverting the
    // pending flags avoids a forever-'pending' badge on an asset no poller
    // will ever claim a job for; the failure is logged for diagnosis.
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
  // #294: embed the fast-path extracted text. Fire-and-forget and flag-gated
  // inside the helper. Ephemeral (ZDR) uploads are never embedded — the durable
  // derived-data invariant — so the guard is explicit here, not left to the
  // helper (which only knows the text, not the ephemeral flag).
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

export { confirmAsset, CONFIRM_MAX_AGE_MS, MAX_EXTRACT_BYTES };
export type { ConfirmResult };
