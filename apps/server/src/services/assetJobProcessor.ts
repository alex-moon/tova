import type { AssetJobDocument } from '../models/AssetJob';
import { Asset } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { convertToMarkdown, extensionOf, isConvertible } from './markdownConversion';
import { extractUnits } from './documentUnits';
import { isImageContentType } from './assetLimits';
import { makeThumbnail } from './imageThumbnail';
import { thumbnailKeyFor } from './assetThumbnails';
import { OCR_MAX_INPUT_BYTES, finalizeOcrText, isNearEmpty, recognizeImage } from './ocr';
import { rasterizePdf } from './pdfRasterize';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

// Real processor for the asset-job queue (issue #67, extended by #208 and
// #209): a job covers whatever the asset still needs. Documents get the
// extension toolchain run and the markdown persisted; images get a bounded
// thumbnail derived and stored alongside the original, and — since #209 —
// their text recovered via OCR so the agent and viewer see it; image-only
// PDFs fall back to OCR when pdf-parse yields no text layer. Jobs whose asset
// is gone or whose lifecycles have both moved on settle as done without
// touching storage. A single job may cover both (markdown and thumbnail) when
// both are pending.

// Match the asset upload cap (MAX_ASSET_SIZE in services/assetLimits.ts);
// declared
// here instead of imported to keep the route module free of worker deps.
export const MAX_CONVERSION_INPUT_BYTES = 15 * 1024 * 1024;

// OCR (issue #209): recover text from a raster buffer, normalise it through
// the shared store-time cap, and treat a blank result as a failure so the
// lifecycle reads honestly rather than as a success-looking empty. The
// "no text" error surfaces via markdownFailureReason like any conversion
// failure.
const ocrBuffer = async (buffer: Buffer): Promise<string> => {
  const text = finalizeOcrText(await recognizeImage(buffer));
  if (text.length === 0) throw new Error('no text found by OCR');
  return text;
};

// Assemble per-page OCR text into the same `-- n of n --` shape pdf-parse
// emits, so `extractUnits` splits a scanned PDF into page units with no new
// read path. `total` is the document's full page count; pages beyond the cap
// are not OCRed (best effort — the text we did recover is still worth
// storing).
const ocrPdfBuffer = async (buffer: Buffer): Promise<string> => {
  const { pages, totalPages } = await rasterizePdf(buffer);
  if (pages.length === 0) throw new Error('no pages rasterised for OCR');
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const text = finalizeOcrText(await recognizeImage(pages[i]!));
    parts.push(`${text}\n-- ${i + 1} of ${totalPages} --`);
  }
  const text = finalizeOcrText(parts.join('\n'));
  if (text.length === 0) throw new Error('no text found by OCR');
  return text;
};

const processConversion = async (
  asset: NonNullable<Awaited<ReturnType<typeof loadAsset>>>,
): Promise<void> => {
  // Issue #209: images are not "convertible" (no markdown toolchain runs for
  // them), yet they now drive this lifecycle via OCR. Branch on the image
  // content type *before* the isConvertible guard, or every image job throws.
  const isImage = isImageContentType(asset.contentType);
  const isPdf = extensionOf(asset.filename) === 'pdf';
  if (!isImage && !isConvertible(asset.filename)) {
    throw new Error(`asset is not a convertible type: ${asset.filename}`);
  }

  const buffer = await spacesWorkspaceStorage.getByKey(asset.key, {
    maxBytes: MAX_CONVERSION_INPUT_BYTES,
  });
  if (!buffer) {
    throw new Error('input-not-readable: object missing or too large');
  }

  let markdown: string;
  if (isImage) {
    // A large image risks exhausting RAM once tesseract allocates its
    // rasters/WASM; skip it with an explicit reason the client already
    // surfaces (markdownStatus 'failed' + reason).
    if (buffer.byteLength > OCR_MAX_INPUT_BYTES) {
      throw new Error('too large for OCR');
    }
    markdown = await ocrBuffer(buffer);
  } else if (isPdf) {
    // Try the text layer first: born-digital PDFs keep it and never pay the
    // OCR cost. Only a (near-)empty result — or the empty-markdown throw —
    // means the PDF is scanned and needs rasterise + OCR.
    const extracted = await convertToMarkdown(asset.filename, buffer).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('empty markdown')) return null;
      throw err;
    });
    if (extracted !== null && !isNearEmpty(extracted)) {
      markdown = extracted;
    } else {
      if (buffer.byteLength > OCR_MAX_INPUT_BYTES) {
        throw new Error('too large for OCR');
      }
      markdown = await ocrPdfBuffer(buffer);
    }
  } else {
    markdown = await convertToMarkdown(asset.filename, buffer);
  }

  asset.markdownExtracted = markdown;
  // Issue #159: slice the (already-capped) conversion into per-unit text.
  asset.set('units', extractUnits(asset.filename, markdown));
  asset.markdownStatus = 'ready';
  asset.markdownFailureReason = null;
  await asset.save();
  // #294: embed the freshly converted text. Jobs only run for non-ephemeral
  // assets (the confirm path never queues one for an ephemeral upload), and the
  // helper is fire-and-forget + flag-gated.
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

  // Run each pending lifecycle independently so a failure in one does not
  // deny the other its result: since #209 an image carries both, and a blank
  // raster that fails OCR must not also lose its (perfectly derivable)
  // thumbnail. The first error still propagates so the job loop retries /
  // terminal-fails the failed lifecycle; the successful one is already saved.
  const errors: unknown[] = [];
  if (needsThumbnail) {
    try {
      await processThumbnail(asset);
    } catch (err) {
      errors.push(err);
    }
  }
  if (needsConversion) {
    try {
      await processConversion(asset);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
};
