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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recognizeImage = exports.finalizeOcrText = exports.isNearEmpty = exports.OCR_LANG = exports.OCR_MAX_PDF_PAGES = exports.OCR_MAX_INPUT_BYTES = exports.OCR_PDF_EMPTY_CHARS = exports.OCR_TIMEOUT_MS = exports.OCR_CACHE_DIR = exports.TESSDATA_DIR = void 0;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const tesseract_js_1 = require("tesseract.js");
const markdownConversion_1 = require("./markdownConversion");
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
// Resolution mirrors the client-build lookup in src/index.ts: relative
// to this file, which reaches the repo root in both `tsx`
// (apps/server/src/services) and the compiled (apps/server/dist/services)
// layouts.
exports.TESSDATA_DIR = path_1.default.join(__dirname, '../../../../assets/tessdata');
// tesseract.js caches the *decompressed* traineddata to `cachePath`, which
// otherwise defaults to the process cwd — littering the working directory with
// a 5 MB `eng.traineddata` on every call. Keep it in the OS temp dir instead;
// the file is rebuilt from the vendored gzip on a cold start, so no state is
// lost. The directory is created by tesseract.js on first write.
exports.OCR_CACHE_DIR = path_1.default.join(os_1.default.tmpdir(), 'tova-ocr-cache');
// Hard ceiling per OCR attempt, mirroring CONVERSION_TIMEOUT_MS: a pathological
// image or a many-page PDF must not wedge the single-flight poller. OCR is
// slower than deterministic conversion, so the budget is larger.
exports.OCR_TIMEOUT_MS = 120000;
// A PDF is treated as "scanned" (and therefore OCRed) when pdf-parse yields
// less than this many characters of text. One tunable constant: born-digital
// PDFs keep their extracted text and never pay the OCR cost.
exports.OCR_PDF_EMPTY_CHARS = 16;
// Conservative input guard for the tiny compute instance: above this many
// bytes we do not rasterise/OCR at all (base64 expansion plus N rasterised
// pages can otherwise exhaust RAM). Images and PDFs both pass through this.
exports.OCR_MAX_INPUT_BYTES = 8 * 1024 * 1024;
// Upper bound on pages rasterised from a single scanned PDF; a very long
// document is truncated rather than allowed to run unbounded.
exports.OCR_MAX_PDF_PAGES = 50;
// The OCR language, and the only one vendored this pass (owner: minimal).
exports.OCR_LANG = 'eng';
// A (near-)empty pdf-parse result means the PDF is scanned/image-only.
const isNearEmpty = (text) => (text !== null && text !== void 0 ? text : '').trim().length < exports.OCR_PDF_EMPTY_CHARS;
exports.isNearEmpty = isNearEmpty;
// Shared store-time normalisation for OCR output: identical cap and cleanup to
// `convertToMarkdown`, via the helper exported from markdownConversion.
const finalizeOcrText = (raw) => (0, markdownConversion_1.finalizeMarkdown)(raw);
exports.finalizeOcrText = finalizeOcrText;
// Run OCR over one raster buffer (a single image, or one rendered PDF page)
// and return the recognised text. A blank/unreadable page returns '' rather
// than throwing — tesseract.js treats an empty page as a valid result, so
// emptiness is the caller's decision. The worker is created per call and
// always terminated: a leaked worker thread would wedge the poller.
const recognizeImage = (buffer_1, ...args_1) => __awaiter(void 0, [buffer_1, ...args_1], void 0, function* (buffer, timeoutMs = exports.OCR_TIMEOUT_MS) {
    var _a;
    const worker = yield (0, tesseract_js_1.createWorker)(exports.OCR_LANG, 1, {
        langPath: exports.TESSDATA_DIR,
        cachePath: exports.OCR_CACHE_DIR,
        gzip: true,
    });
    try {
        // tesseract.js accepts a Node Buffer/Uint8Array at runtime, but its
        // `ImageLike` union only lists DOM image types, so go through `unknown`.
        const image = new Uint8Array(buffer);
        const result = yield (0, markdownConversion_1.withTimeout)(worker.recognize(image), timeoutMs);
        return (_a = result.data.text) !== null && _a !== void 0 ? _a : '';
    }
    finally {
        yield worker.terminate();
    }
});
exports.recognizeImage = recognizeImage;
