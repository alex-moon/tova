import { PDFParse } from 'pdf-parse';
import { OCR_MAX_PDF_PAGES } from './ocr';

// PDF rasterisation (issue #209): a scanned PDF has no text layer, so it must
// be rendered to page images before OCR. Rather than add an ESM-only rasteriser
// (`pdf-to-img`) to this CommonJS build — which ts-jest and `tsc` would
// downlevel `import()` into a broken `require()` — we reuse the renderer
// already shipped as a first-party dependency: `pdf-parse` (the same library
// `markdownConversion` uses for text) exposes `getScreenshot()`, backed by its
// bundled pdf.js + `@napi-rs/canvas`. No new runtime dependency, no glue.

// Render scale: the main RAM/time lever. 2× is legible for OCR (pdf.js default
// is 1×) while keeping page images modest on the tiny instance.
export const PDF_RASTER_SCALE = 2;

export interface RasterizedPdf {
  pages: Buffer[];
  // Total pages in the document, before the OCR_MAX_PDF_PAGES truncation.
  totalPages: number;
}

// Render a PDF buffer to one PNG buffer per page (capped at maxPages). Throws
// on an unreadable/encrypted document so the job loop records a reason; the
// asset itself is unaffected.
export const rasterizePdf = async (
  buffer: Buffer,
  maxPages = OCR_MAX_PDF_PAGES,
  scale = PDF_RASTER_SCALE,
): Promise<RasterizedPdf> => {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getScreenshot({
      scale,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const pages = result.pages.slice(0, maxPages).map((page) => Buffer.from(page.data));
    return { pages, totalPages: result.total };
  } finally {
    await parser.destroy?.();
  }
};
