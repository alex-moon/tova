import { PDFParse } from 'pdf-parse';
import { OCR_MAX_PDF_PAGES } from './ocr';

// PDF rasterisation: reuses pdf-parse's bundled pdf.js renderer.
// @see #209 #396

// Render scale: the main RAM/time lever; 2× is legible for OCR.
export const PDF_RASTER_SCALE = 2;

export interface RasterizedPdf {
  // Total pages in the document, before the OCR_MAX_PDF_PAGES truncation.
  totalPages: number;
}

// Render a PDF one page at a time (capped), handing each PNG to `onPage` so
// no more than a single rasterised page is ever resident. Throws on
// unreadable docs.
// @see #396
export const rasterizePdf = async (
  buffer: Buffer,
  onPage: (page: Buffer, index: number, totalPages: number) => Promise<void>,
  maxPages = OCR_MAX_PDF_PAGES,
  scale = PDF_RASTER_SCALE,
): Promise<RasterizedPdf> => {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const render = (page: number) =>
      parser.getScreenshot({
        scale,
        imageBuffer: true,
        imageDataUrl: false,
        partial: [page],
      });
    // The first render also reports the document's total page count.
    const first = await render(1);
    const totalPages = first.total;
    const count = Math.min(totalPages, maxPages);
    for (let page = 1; page <= count; page += 1) {
      const result = page === 1 ? first : await render(page);
      const data = result.pages[0]?.data;
      if (!data) continue;
      await onPage(Buffer.from(data), page - 1, totalPages);
    }
    return { totalPages };
  } finally {
    await parser.destroy?.();
  }
};
