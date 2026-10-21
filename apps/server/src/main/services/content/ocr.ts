import fs from 'fs';
import os from 'os';
import path from 'path';
import { createWorker } from 'tesseract.js';
import { finalizeMarkdown, withTimeout } from './markdownConversion';
import { redactForLog } from '../logRedaction';

/* OCR for images and image-only PDFs: self-hosted tesseract.js. */
// @see #209 #358

// Traineddata is vendored; walk up from __dirname to the first copy.
// @see #358
const TESSDATA_GZ = 'eng.traineddata.gz';

export const findTessdataDir = (from: string = __dirname): string => {
  let dir = from;
  for (let hop = 0; hop < 8; hop += 1) {
    // nosemgrep: path-join-resolve-traversal.path-join-resolve-traversal
    const candidate = path.join(dir, 'assets', 'tessdata');
    // nosemgrep: path-join-resolve-traversal.path-join-resolve-traversal
    if (fs.existsSync(path.join(candidate, TESSDATA_GZ))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // nosemgrep: path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(from, 'assets', 'tessdata');
};

export const TESSDATA_DIR = findTessdataDir();

// tesseract.js decompresses to cachePath; keep it out of cwd, in tmp.
export const OCR_CACHE_DIR = path.join(os.tmpdir(), 'tova-ocr-cache');

// Per-attempt ceiling: a pathological input must not wedge the poller.
export const OCR_TIMEOUT_MS = 120_000;

// A PDF is "scanned" when pdf-parse yields fewer characters than this.
// @see #209
export const OCR_PDF_EMPTY_CHARS = 16;

// Input guard: above this, rasterising/OCRing could exhaust RAM.
export const OCR_MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Upper bound on pages rasterised; truncation over unbounded.
export const OCR_MAX_PDF_PAGES = 50;

// The OCR language, and the only one vendored.
export const OCR_LANG = 'eng';

// A (near-)empty pdf-parse result means the PDF is scanned/image-only.
export const isNearEmpty = (text: string | null | undefined): boolean =>
  (text ?? '').trim().length < OCR_PDF_EMPTY_CHARS;

// Store-time normalisation: same cap and cleanup as convertToMarkdown.
export const finalizeOcrText = (raw: string): string => finalizeMarkdown(raw);

// OCR one raster buffer; blank returns '' (caller decides); terminate worker.
export const recognizeImage = async (
  buffer: Buffer,
  timeoutMs = OCR_TIMEOUT_MS,
): Promise<string> => {
  // createWorker settles only on success; bound it with the same timeout.
  // @see #358
  const worker = await withTimeout(
    createWorker(OCR_LANG, 1, {
      langPath: TESSDATA_DIR,
      cachePath: OCR_CACHE_DIR,
      gzip: true,
      // Without an errorHandler, worker failures crash the process.
      // @see #358
      errorHandler: (err) => console.error('[OCR] tesseract worker error:', redactForLog(err)),
    }),
    timeoutMs,
  );
  try {
    // Runtime accepts a Buffer but ImageLike omits it; go through unknown.
    const image = new Uint8Array(buffer) as unknown as Parameters<typeof worker.recognize>[0];
    const result = await withTimeout(worker.recognize(image), timeoutMs);
    return result.data.text ?? '';
  } finally {
    await worker.terminate();
  }
};
