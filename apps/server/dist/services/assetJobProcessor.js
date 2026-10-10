"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processAssetConversionJob = exports.MAX_CONVERSION_INPUT_BYTES = void 0;
const Asset_1 = require("../models/Asset");
const workspaceStorage_1 = require("./workspaceStorage");
const markdownConversion_1 = require("./markdownConversion");
const documentUnits_1 = require("./documentUnits");
const assetLimits_1 = require("./assetLimits");
const imageThumbnail_1 = require("./imageThumbnail");
const assetThumbnails_1 = require("./assetThumbnails");
const ocr_1 = require("./ocr");
const pdfRasterize_1 = require("./pdfRasterize");
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
exports.MAX_CONVERSION_INPUT_BYTES = 15 * 1024 * 1024;
// OCR (issue #209): recover text from a raster buffer, normalise it through
// the shared store-time cap, and treat a blank result as a failure so the
// lifecycle reads honestly rather than as a success-looking empty. The
// "no text" error surfaces via markdownFailureReason like any conversion
// failure.
const ocrBuffer = (buffer) => __awaiter(void 0, void 0, void 0, function* () {
    const text = (0, ocr_1.finalizeOcrText)(yield (0, ocr_1.recognizeImage)(buffer));
    if (text.length === 0)
        throw new Error('no text found by OCR');
    return text;
});
// Assemble per-page OCR text into the same `-- n of n --` shape pdf-parse
// emits, so `extractUnits` splits a scanned PDF into page units with no new
// read path. `total` is the document's full page count; pages beyond the cap
// are not OCRed (best effort — the text we did recover is still worth
// storing).
const ocrPdfBuffer = (buffer) => __awaiter(void 0, void 0, void 0, function* () {
    const { pages, totalPages } = yield (0, pdfRasterize_1.rasterizePdf)(buffer);
    if (pages.length === 0)
        throw new Error('no pages rasterised for OCR');
    const parts = [];
    for (let i = 0; i < pages.length; i++) {
        const text = (0, ocr_1.finalizeOcrText)(yield (0, ocr_1.recognizeImage)(pages[i]));
        parts.push(`${text}\n-- ${i + 1} of ${totalPages} --`);
    }
    const text = (0, ocr_1.finalizeOcrText)(parts.join('\n'));
    if (text.length === 0)
        throw new Error('no text found by OCR');
    return text;
});
const processConversion = (asset) => __awaiter(void 0, void 0, void 0, function* () {
    // Issue #209: images are not "convertible" (no markdown toolchain runs for
    // them), yet they now drive this lifecycle via OCR. Branch on the image
    // content type *before* the isConvertible guard, or every image job throws.
    const isImage = (0, assetLimits_1.isImageContentType)(asset.contentType);
    const isPdf = (0, markdownConversion_1.extensionOf)(asset.filename) === 'pdf';
    if (!isImage && !(0, markdownConversion_1.isConvertible)(asset.filename)) {
        throw new Error(`asset is not a convertible type: ${asset.filename}`);
    }
    const buffer = yield workspaceStorage_1.spacesWorkspaceStorage.getByKey(asset.key, {
        maxBytes: exports.MAX_CONVERSION_INPUT_BYTES,
    });
    if (!buffer) {
        throw new Error('input-not-readable: object missing or too large');
    }
    let markdown;
    if (isImage) {
        // A large image risks exhausting RAM once tesseract allocates its
        // rasters/WASM; skip it with an explicit reason the client already
        // surfaces (markdownStatus 'failed' + reason).
        if (buffer.byteLength > ocr_1.OCR_MAX_INPUT_BYTES) {
            throw new Error('too large for OCR');
        }
        markdown = yield ocrBuffer(buffer);
    }
    else if (isPdf) {
        // Try the text layer first: born-digital PDFs keep it and never pay the
        // OCR cost. Only a (near-)empty result — or the empty-markdown throw —
        // means the PDF is scanned and needs rasterise + OCR.
        const extracted = yield (0, markdownConversion_1.convertToMarkdown)(asset.filename, buffer).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('empty markdown'))
                return null;
            throw err;
        });
        if (extracted !== null && !(0, ocr_1.isNearEmpty)(extracted)) {
            markdown = extracted;
        }
        else {
            if (buffer.byteLength > ocr_1.OCR_MAX_INPUT_BYTES) {
                throw new Error('too large for OCR');
            }
            markdown = yield ocrPdfBuffer(buffer);
        }
    }
    else {
        markdown = yield (0, markdownConversion_1.convertToMarkdown)(asset.filename, buffer);
    }
    asset.markdownExtracted = markdown;
    // Issue #159: slice the (already-capped) conversion into per-unit text.
    asset.set('units', (0, documentUnits_1.extractUnits)(asset.filename, markdown));
    asset.markdownStatus = 'ready';
    asset.markdownFailureReason = null;
    yield asset.save();
});
const processThumbnail = (asset) => __awaiter(void 0, void 0, void 0, function* () {
    if (!(0, assetLimits_1.isImageContentType)(asset.contentType)) {
        throw new Error(`asset is not an image: ${asset.contentType}`);
    }
    const buffer = yield workspaceStorage_1.spacesWorkspaceStorage.getByKey(asset.key, {
        maxBytes: exports.MAX_CONVERSION_INPUT_BYTES,
    });
    if (!buffer) {
        throw new Error('input-not-readable: object missing or too large');
    }
    const thumbnail = yield (0, imageThumbnail_1.makeThumbnail)(buffer);
    const key = (0, assetThumbnails_1.thumbnailKeyFor)(String(asset.userId), asset._id);
    yield workspaceStorage_1.spacesWorkspaceStorage.putByKey(key, thumbnail.buffer, 'image/png');
    asset.thumbnailKey = key;
    asset.thumbnailStatus = 'ready';
    yield asset.save();
});
const loadAsset = (assetId) => Asset_1.Asset.findById(assetId).select('userId filename key contentType status textExtracted markdownExtracted markdownStatus markdownFailureReason thumbnailKey thumbnailStatus size units');
const processAssetConversionJob = (job) => __awaiter(void 0, void 0, void 0, function* () {
    const asset = yield loadAsset(job.assetId);
    if (!asset || asset.status !== 'ready')
        return;
    const needsConversion = asset.markdownStatus === 'pending';
    const needsThumbnail = asset.thumbnailStatus === 'pending';
    if (!needsConversion && !needsThumbnail)
        return;
    // Run each pending lifecycle independently so a failure in one does not
    // deny the other its result: since #209 an image carries both, and a blank
    // raster that fails OCR must not also lose its (perfectly derivable)
    // thumbnail. The first error still propagates so the job loop retries /
    // terminal-fails the failed lifecycle; the successful one is already saved.
    const errors = [];
    if (needsThumbnail) {
        try {
            yield processThumbnail(asset);
        }
        catch (err) {
            errors.push(err);
        }
    }
    if (needsConversion) {
        try {
            yield processConversion(asset);
        }
        catch (err) {
            errors.push(err);
        }
    }
    if (errors.length > 0)
        throw errors[0];
});
exports.processAssetConversionJob = processAssetConversionJob;
