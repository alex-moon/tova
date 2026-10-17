import fs from 'fs';
import os from 'os';
import path from 'path';
import { createWorker } from 'tesseract.js';
import { finalizeMarkdown, withTimeout } from './markdownConversion';
import { redactForLog } from './logRedaction';

/* OCR for images and image-only PDFs: self-hosted tesseract.js over a raster buffer; deliberately pure (no storage/Mongo/routes) and vendored traineddata so recognition never needs egress. */
// @see #209 #358

// Traineddata is vendored at build time; the repo root sits a different number of levels above this file per layout, so walk up from __dirname to the first vendored copy.
// @see #358
const TESSDATA_GZ = 'eng.traineddata.gz';

export const findTessdataDir = (from: string = __dirname): string => {
  let dir = from;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = path.join(dir, 'assets', 'tessdata');
    if (fs.existsSync(path.join(candidate, TESSDATA_GZ))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(from, 'assets', 'tessdata');
};

export const TESSDATA_DIR = findTessdataDir();

// tesseract.js caches the decompressed traineddata to `cachePath`, which otherwise litters cwd; keep it in the OS temp dir (rebuilt from the vendored gzip on cold start).
export const OCR_CACHE_DIR = path.join(os.tmpdir(), 'tova-ocr-cache');

// Hard ceiling per OCR attempt: a pathological image or many-page PDF must not wedge the single-flight poller.
export const OCR_TIMEOUT_MS = 120_000;

// A PDF is treated as "scanned" when pdf-parse yields less than this many characters; born-digital PDFs never pay the OCR cost.
// @see #209
export const OCR_PDF_EMPTY_CHARS = 16;

// Conservative input guard for the tiny compute instance: above this, rasterising/OCRing could exhaust RAM.
export const OCR_MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Upper bound on pages rasterised from a single scanned PDF; truncation over running unbounded.
export const OCR_MAX_PDF_PAGES = 50;

// The OCR language, and the only one vendored.
export const OCR_LANG = 'eng';

// A (near-)empty pdf-parse result means the PDF is scanned/image-only.
export const isNearEmpty = (text: string | null | undefined): boolean =>
  (text ?? '').trim().length < OCR_PDF_EMPTY_CHARS;

// Shared store-time normalisation for OCR output: identical cap and cleanup to convertToMarkdown.
export const finalizeOcrText = (raw: string): string => finalizeMarkdown(raw);

// Run OCR over one raster buffer; a blank page returns '' rather than throwing (emptiness is the caller's decision); the worker is always terminated — a leaked worker thread would wedge the poller.
export const recognizeImage = async (
  buffer: Buffer,
  timeoutMs = OCR_TIMEOUT_MS,
): Promise<string> => {
  // The same budget bounds worker creation: tesseract.js v7 settles createWorker only on full success, so a load failure would hang the await forever (or crash with an errorHandler); a timed-out creation's worker is abandoned.
  // @see #358
  const worker = await withTimeout(
    createWorker(OCR_LANG, 1, {
      langPath: TESSDATA_DIR,
      cachePath: OCR_CACHE_DIR,
      gzip: true,
      // tesseract.js re-throws worker failures from its message handler when no errorHandler is set — a throw inside a Worker 'message' event bypasses every try/catch and terminates the process; contained here.
      // @see #358
      errorHandler: (err) => console.error('[OCR] tesseract worker error:', redactForLog(err)),
    }),
    timeoutMs,
  );
  try {
    // tesseract.js accepts a Node Buffer at runtime, but its `ImageLike` union only lists DOM image types, so go through `unknown`.
    const image = new Uint8Array(buffer) as unknown as Parameters<typeof worker.recognize>[0];
    const result = await withTimeout(worker.recognize(image), timeoutMs);
    return result.data.text ?? '';
  } finally {
    await worker.terminate();
  }
};
