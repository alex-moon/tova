import { PDFParse } from 'pdf-parse';
import { OCR_MAX_PDF_PAGES } from './ocr';

// PDF rasterisation for scanned PDFs: reuses pdf-parse's bundled pdf.js renderer (an ESM-only rasteriser would downlevel to a broken require() in this CommonJS build).
// @see #209

// Render scale: the main RAM/time lever; 2× is legible for OCR while keeping page images modest.
export const PDF_RASTER_SCALE = 2;

export interface RasterizedPdf {
  pages: Buffer[];
  // Total pages in the document, before the OCR_MAX_PDF_PAGES truncation.
  totalPages: number;
}

// Render a PDF buffer to one PNG per page (capped); throws on an unreadable/encrypted document so the job loop records a reason.
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
