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
exports.convertToMarkdown = exports.finalizeMarkdown = exports.withTimeout = exports.isConvertible = exports.extensionOf = exports.htmlToMarkdown = exports.CONVERSION_TIMEOUT_MS = exports.MAX_MARKDOWN_CHARS = exports.CONVERTIBLE_EXTENSIONS = void 0;
const mammoth_1 = __importDefault(require("mammoth"));
const turndown_1 = __importDefault(require("turndown"));
const pdf_parse_1 = require("pdf-parse");
// Markdown conversion (issue #67): JS-native toolchain (mammoth for docx,
// pdf-parse — pdf.js — for PDF, turndown for HTML) instead of a markitdown
// Python subprocess: no new runtime, sidecar or queue infra. Conversion is
// deterministic-failfile: unknown extensions and empty results throw so the
// job loop retries/fails with a reason. Extension decided from the filename
// like textExtraction (#34), not the client-provided contentType.
exports.CONVERTIBLE_EXTENSIONS = new Set(['pdf', 'docx', 'html', 'htm']);
// Storage cap on the persisted markdown (issue #67): conversion output is
// trimmed at store time; the 12k prompt cap applies at use time, so a large
// document still contributes its head to search/attach.
exports.MAX_MARKDOWN_CHARS = 200000;
// Hard ceiling per conversion attempt: a hung parser must not wedge the
// poller; the job loop treats the timeout as any other failure.
exports.CONVERSION_TIMEOUT_MS = 30000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const turndownInstance = new turndown_1.default({ headingStyle: 'atx', bulletListMarker: '-' });
// HTML→markdown conversion used both by asset ingestion (rawConvert below)
// and by the `fetch_url` page fetcher (issue #113): one turndown instance,
// owned by this module.
const htmlToMarkdown = (html) => turndownInstance.turndown(html);
exports.htmlToMarkdown = htmlToMarkdown;
const extensionOf = (filename) => {
    const dot = filename.lastIndexOf('.');
    return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};
exports.extensionOf = extensionOf;
const isConvertible = (filename) => exports.CONVERTIBLE_EXTENSIONS.has((0, exports.extensionOf)(filename));
exports.isConvertible = isConvertible;
const withTimeout = (promise, ms = exports.CONVERSION_TIMEOUT_MS) => Promise.race([
    promise,
    new Promise((_, reject) => {
        var _a;
        const t = setTimeout(() => reject(new Error(`conversion timed out after ${ms}ms`)), ms);
        // Keep the process from being held open by an orphaned timer (tests).
        (_a = t.unref) === null || _a === void 0 ? void 0 : _a.call(t);
    }),
]);
exports.withTimeout = withTimeout;
// Store-time normalisation shared by every producer of `markdownExtracted`
// (issue #67 conversion, issue #209 OCR): normalise line endings, unify the
// curly apostrophe, trim, and enforce the storage cap. Exported so the OCR
// stage — which does not go through `convertToMarkdown` for images — applies
// exactly the same cap rather than duplicating it.
const finalizeMarkdown = (raw) => raw
    .replace(/\r\n/g, '\n')
    .replace(/\u2019/g, "'")
    .trim()
    .slice(0, exports.MAX_MARKDOWN_CHARS);
exports.finalizeMarkdown = finalizeMarkdown;
// Convert a document buffer to markdown. Throws on unsupported extension,
// converter error, or empty conversion output.
const convertToMarkdown = (filename_1, buffer_1, ...args_1) => __awaiter(void 0, [filename_1, buffer_1, ...args_1], void 0, function* (filename, buffer, timeoutMs = exports.CONVERSION_TIMEOUT_MS) {
    const ext = (0, exports.extensionOf)(filename);
    if (!exports.CONVERTIBLE_EXTENSIONS.has(ext)) {
        throw new Error(`unsupported conversion type: .${ext || '(none)'}`);
    }
    const raw = yield (0, exports.withTimeout)(rawConvert(ext, buffer), timeoutMs);
    if (raw == null) {
        throw new Error(`conversion produced no text for .${ext}`);
    }
    const markdown = (0, exports.finalizeMarkdown)(raw);
    if (markdown.length === 0) {
        throw new Error(`conversion produced empty markdown for .${ext}`);
    }
    return markdown;
});
exports.convertToMarkdown = convertToMarkdown;
const rawConvert = (ext, buffer) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    switch (ext) {
        case 'pdf': {
            // PDF text comes out in reading order with plain page separators
            // (`-- n of n --`); keep it verbatim rather than re-styling it.
            const parser = new pdf_parse_1.PDFParse({ data: new Uint8Array(buffer) });
            try {
                const result = yield parser.getText();
                return (_a = result === null || result === void 0 ? void 0 : result.text) !== null && _a !== void 0 ? _a : '';
            }
            finally {
                yield ((_b = parser.destroy) === null || _b === void 0 ? void 0 : _b.call(parser));
            }
        }
        case 'docx': {
            // mammoth's bundled typings miss the 'convertToMarkdown' helper.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const converter = mammoth_1.default;
            return converter.convertToMarkdown({ buffer }).then((r) => r.value);
        }
        case 'html':
        case 'htm':
            return (0, exports.htmlToMarkdown)(buffer.toString('utf8'));
        default:
            throw new Error(`unsupported conversion type: .${ext}`);
    }
});
