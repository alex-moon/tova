import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import {
  OCR_CACHE_DIR,
  OCR_PDF_EMPTY_CHARS,
  TESSDATA_DIR,
  finalizeOcrText,
  isNearEmpty,
  recognizeImage,
} from '../../main/services/ocr';
import { rasterizePdf } from '../../main/services/pdfRasterize';
import { MAX_MARKDOWN_CHARS } from '../../main/services/markdownConversion';

// Issue #209: real tesseract.js OCR against in-memory rasters and a real
// image-only PDF fixture. The engine is slow (seconds per page), so these
// tests carry explicit per-test timeouts and one worker per test.

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'main', 'services', 'fixtures');
const fixture = (file: 'scanned.pdf'): Buffer => readFileSync(`${FIXTURE_DIR}/${file}`);

// A larger, high-contrast render is far more reliable for OCR than a tiny
// canvas, so use a generous size and a plain sans-serif font.
const pngWithText = (text: string): Buffer => {
  const width = 800;
  const height = 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = '64px sans-serif';
  ctx.fillText(text, 20, 120);
  return canvas.toBuffer('image/png');
};

const blankPng = (): Buffer => {
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 100);
  return canvas.toBuffer('image/png');
};

describe('ocr constants (#209)', () => {
  it('points at the vendored traineddata directory, no trailing slash', () => {
    expect(TESSDATA_DIR.endsWith('assets/tessdata')).toBe(true);
    expect(TESSDATA_DIR.endsWith('/')).toBe(false);
  });

  it('keeps the traineddata decompression cache out of the working directory', () => {
    expect(OCR_CACHE_DIR.startsWith(os.tmpdir())).toBe(true);
  });
});

describe('isNearEmpty (#209)', () => {
  it('treats null/blank/separator-only text as near-empty', () => {
    expect(isNearEmpty(null)).toBe(true);
    expect(isNearEmpty(undefined)).toBe(true);
    expect(isNearEmpty('   \n  ')).toBe(true);
    expect(isNearEmpty('-- 1 of 1 --')).toBe(true);
  });

  it('treats real text as not near-empty', () => {
    expect(isNearEmpty('Hello Tova, this is real text')).toBe(false);
    expect(isNearEmpty('word '.repeat(OCR_PDF_EMPTY_CHARS))).toBe(false);
  });
});

describe('finalizeOcrText (#209)', () => {
  it('normalises line endings and the curly apostrophe, then trims', () => {
    expect(finalizeOcrText('  a\r\nb\u2019c  ')).toBe("a\nb'c");
  });

  it('caps at the shared markdown storage cap', () => {
    const huge = 'x'.repeat(MAX_MARKDOWN_CHARS + 1000);
    expect(finalizeOcrText(huge).length).toBe(MAX_MARKDOWN_CHARS);
  });
});

describe('rasterizePdf (#209)', () => {
  it('renders each page of an image-only PDF to a PNG buffer', async () => {
    const { pages, totalPages } = await rasterizePdf(fixture('scanned.pdf'));
    expect(totalPages).toBe(1);
    expect(pages).toHaveLength(1);
    // PNG magic number.
    expect(pages[0]!.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }, 30_000);

  it('enforces the page cap without throwing', async () => {
    const { pages, totalPages } = await rasterizePdf(fixture('scanned.pdf'), 0);
    expect(totalPages).toBe(1);
    expect(pages).toHaveLength(0);
  }, 30_000);
});

describe('recognizeImage (#209)', () => {
  it('reads known text from a rendered image', async () => {
    const text = await recognizeImage(pngWithText('HELLO OCR 123'));
    expect(text.toUpperCase()).toContain('OCR');
    expect(text).toMatch(/123/);
  }, 120_000);

  it('returns empty text for a blank image without throwing', async () => {
    const text = await recognizeImage(blankPng());
    expect(text.trim()).toBe('');
  }, 120_000);

  it('OCRs a scanned PDF page end to end', async () => {
    const { pages } = await rasterizePdf(fixture('scanned.pdf'));
    const text = finalizeOcrText(await recognizeImage(pages[0]!));
    expect(text.toUpperCase()).toContain('SCANNED');
    expect(text).toContain('555');
  }, 120_000);
});
