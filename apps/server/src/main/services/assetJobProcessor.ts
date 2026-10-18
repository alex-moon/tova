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

/* Real processor for the asset-job queue: conversion, OCR, thumbnails. */
// @see #67 #208 #209

// Mirrors the asset upload cap; keeps route modules free of worker deps.
const MAX_CONVERSION_INPUT_BYTES = 15 * 1024 * 1024;

/* OCR a raster buffer, normalised through the store-time cap. */
// @see #209
const ocrBuffer = async (buffer: Buffer): Promise<string> => {
  const text = finalizeOcrText(await recognizeImage(buffer));
  if (text.length === 0) throw new Error('no text found by OCR');
  return text;
};

/* Assemble per-page OCR text into the pdf-parse `-- n of n --` shape. */
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
  // Images drive this lifecycle via OCR; check before the isConvertible guard.
  // @see #209
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
    // Large images can exhaust RAM in tesseract; skip with a reason.
    if (buffer.byteLength > OCR_MAX_INPUT_BYTES) {
      throw new Error('too large for OCR');
    }
    markdown = await ocrBuffer(buffer);
  } else if (isPdf) {
    // Text layer first: born-digital PDFs skip OCR; near-empty means scanned.
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
  // Slice the (already-capped) conversion into per-unit text.
  // @see #159
  asset.set('units', extractUnits(asset.filename, markdown));
  asset.markdownStatus = 'ready';
  asset.markdownFailureReason = null;
  await asset.save();
  // Embed converted text: fire-and-forget, flag-gated, never ephemeral.
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

  // Lifecycles run independently so one failure cannot deny the other.
  // @see #209
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
