import fs from 'fs';
import os from 'os';
import path from 'path';
import { createWorker } from 'tesseract.js';
import { finalizeMarkdown, withTimeout } from './markdownConversion';
import { redactForLog } from './logRedaction';

// OCR (issue #209): images and image-only PDFs currently yield no text, so the
// viewer shows "(no extracted text)" and the agent's read_file returns
// hasText:false. This service runs self-hosted OCR (tesseract.js — owner
// decision, vanilla English) over a raster buffer and returns the recognised
// text. It is deliberately pure: no storage, no Mongoose, no route knowledge,
// so it is unit-testable in isolation.
//
// The engine is English-only ("eng") and its traineddata is vendored under
// `assets/tessdata` (see `TESSDATA_DIR`) so the live worker never needs egress
// to a CDN at recognition time. tesseract.js runs in-process (its WASM core is
// bundled by the npm package); no new service or sidecar is introduced.

// Traineddata is vendored at build time; `langPath` has no trailing slash and
// tesseract.js loads `${langPath}/eng.traineddata.gz` when `gzip: true`.
// The repo root sits a different number of levels above this file in each
// layout (tsx: src/main/services; compiled: dist/services, rootDir src/main),
// so a fixed upward hop count silently resolved to /assets/tessdata in the
// prod image — the ENOENT behind the #358 outage. Walk up from __dirname to
// the first vendored copy instead of counting hops.
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

// tesseract.js caches the *decompressed* traineddata to `cachePath`, which
// otherwise defaults to the process cwd — littering the working directory with
// a 5 MB `eng.traineddata` on every call. Keep it in the OS temp dir instead;
// the file is rebuilt from the vendored gzip on a cold start, so no state is
// lost. The directory is created by tesseract.js on first write.
export const OCR_CACHE_DIR = path.join(os.tmpdir(), 'tova-ocr-cache');

// Hard ceiling per OCR attempt, mirroring CONVERSION_TIMEOUT_MS: a pathological
// image or a many-page PDF must not wedge the single-flight poller. OCR is
// slower than deterministic conversion, so the budget is larger.
export const OCR_TIMEOUT_MS = 120_000;

// A PDF is treated as "scanned" (and therefore OCRed) when pdf-parse yields
// less than this many characters of text. One tunable constant: born-digital
// PDFs keep their extracted text and never pay the OCR cost.
export const OCR_PDF_EMPTY_CHARS = 16;

// Conservative input guard for the tiny compute instance: above this many
// bytes we do not rasterise/OCR at all (base64 expansion plus N rasterised
// pages can otherwise exhaust RAM). Images and PDFs both pass through this.
export const OCR_MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Upper bound on pages rasterised from a single scanned PDF; a very long
// document is truncated rather than allowed to run unbounded.
export const OCR_MAX_PDF_PAGES = 50;

// The OCR language, and the only one vendored this pass (owner: minimal).
export const OCR_LANG = 'eng';

// A (near-)empty pdf-parse result means the PDF is scanned/image-only.
export const isNearEmpty = (text: string | null | undefined): boolean =>
  (text ?? '').trim().length < OCR_PDF_EMPTY_CHARS;

// Shared store-time normalisation for OCR output: identical cap and cleanup to
// `convertToMarkdown`, via the helper exported from markdownConversion.
export const finalizeOcrText = (raw: string): string => finalizeMarkdown(raw);

// Run OCR over one raster buffer (a single image, or one rendered PDF page)
// and return the recognised text. A blank/unreadable page returns '' rather
// than throwing — tesseract.js treats an empty page as a valid result, so
// emptiness is the caller's decision. The worker is created per call and
// always terminated: a leaked worker thread would wedge the poller.
export const recognizeImage = async (
  buffer: Buffer,
  timeoutMs = OCR_TIMEOUT_MS,
): Promise<string> => {
  // The same budget bounds worker creation. tesseract.js v7 settles the
  // createWorker promise only on full success (its internal chain ends in
  // `.catch(() => {})`), so a load failure — the #358 ENOENT — would hang
  // the await forever with no errorHandler, or crash the process with one.
  // The timeout keeps the single-flight poller alive either way; the
  // (idle) worker thread behind a timed-out creation is abandoned.
  const worker = await withTimeout(
    createWorker(OCR_LANG, 1, {
      langPath: TESSDATA_DIR,
      cachePath: OCR_CACHE_DIR,
      gzip: true,
      // tesseract.js re-throws worker failures from its own message handler
      // when no errorHandler option is set — a throw inside a Worker 'message'
      // event bypasses every try/catch and terminates the process (#358). The
      // failure is contained here; the creation timeout above turns it into a
      // rejected promise the job runner can settle.
      errorHandler: (err) => console.error('[OCR] tesseract worker error:', redactForLog(err)),
    }),
    timeoutMs,
  );
  try {
    // tesseract.js accepts a Node Buffer/Uint8Array at runtime, but its
    // `ImageLike` union only lists DOM image types, so go through `unknown`.
    const image = new Uint8Array(buffer) as unknown as Parameters<typeof worker.recognize>[0];
    const result = await withTimeout(worker.recognize(image), timeoutMs);
    return result.data.text ?? '';
  } finally {
    await worker.terminate();
  }
};
