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
exports.rasterizePdf = exports.PDF_RASTER_SCALE = void 0;
const pdf_parse_1 = require("pdf-parse");
const ocr_1 = require("./ocr");
// PDF rasterisation (issue #209): a scanned PDF has no text layer, so it must
// be rendered to page images before OCR. Rather than add an ESM-only rasteriser
// (`pdf-to-img`) to this CommonJS build — which ts-jest and `tsc` would
// downlevel `import()` into a broken `require()` — we reuse the renderer
// already shipped as a first-party dependency: `pdf-parse` (the same library
// `markdownConversion` uses for text) exposes `getScreenshot()`, backed by its
// bundled pdf.js + `@napi-rs/canvas`. No new runtime dependency, no glue.
// Render scale: the main RAM/time lever. 2× is legible for OCR (pdf.js default
// is 1×) while keeping page images modest on the tiny instance.
exports.PDF_RASTER_SCALE = 2;
// Render a PDF buffer to one PNG buffer per page (capped at maxPages). Throws
// on an unreadable/encrypted document so the job loop records a reason; the
// asset itself is unaffected.
const rasterizePdf = (buffer_1, ...args_1) => __awaiter(void 0, [buffer_1, ...args_1], void 0, function* (buffer, maxPages = ocr_1.OCR_MAX_PDF_PAGES, scale = exports.PDF_RASTER_SCALE) {
    var _a;
    const parser = new pdf_parse_1.PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = yield parser.getScreenshot({
            scale,
            imageBuffer: true,
            imageDataUrl: false,
        });
        const pages = result.pages.slice(0, maxPages).map((page) => Buffer.from(page.data));
        return { pages, totalPages: result.total };
    }
    finally {
        yield ((_a = parser.destroy) === null || _a === void 0 ? void 0 : _a.call(parser));
    }
});
exports.rasterizePdf = rasterizePdf;
