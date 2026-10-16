import { readFileSync } from 'fs';
import { Types } from 'mongoose';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { Asset } from '../../main/models/Asset';
import { AssetJob } from '../../main/models/AssetJob';
import { runAssetJobTick } from '../../main/services/assetJobService';
import { processAssetConversionJob } from '../../main/services/assetJobProcessor';
import { OCR_MAX_INPUT_BYTES } from '../../main/services/ocr';

// Issue #209: the OCR branch of the asset-job processor. The real tesseract
// engine is slow (seconds per page), so `recognizeImage` is mocked while every
// other OCR concern (finalize/cap, isNearEmpty, size guard, page separators,
// unit derivation) runs for real. The born-digital PDF path must never call
// the OCR mock.

const mockGetObjectBuffer = jest.fn();
const mockPutObject = jest.fn();
const mockRecognizeImage = jest.fn();
const mockRasterizePdf = jest.fn();

jest.mock('../../main/services/storageService', () => ({
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

jest.mock('../../main/services/ocr', () => {
  const actual =
    jest.requireActual<typeof import('../../main/services/ocr')>('../../main/services/ocr');
  return { ...actual, recognizeImage: (...args: unknown[]) => mockRecognizeImage(...args) };
});

jest.mock('../../main/services/pdfRasterize', () => ({
  rasterizePdf: (...args: unknown[]) => mockRasterizePdf(...args),
}));

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'main', 'services', 'fixtures');
const fixture = (file: 'sample.pdf' | 'scanned.pdf'): Buffer =>
  readFileSync(`${FIXTURE_DIR}/${file}`);

const pngOf = (width: number, height: number): Buffer => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
};

const seedAsset = async (opts: {
  filename: string;
  contentType: string;
  buffer: Buffer;
  markdownStatus?: 'pending' | 'ready' | 'none';
  thumbnailStatus?: 'pending' | 'ready' | 'none';
}): Promise<ReturnType<typeof Asset.create>> => {
  const asset = await Asset.create({
    userId: new Types.ObjectId(),
    filename: opts.filename,
    key: `u/a/${opts.filename}`,
    contentType: opts.contentType,
    size: opts.buffer.length,
    status: 'ready',
    markdownStatus: opts.markdownStatus ?? 'pending',
    thumbnailStatus: opts.thumbnailStatus ?? 'none',
  });
  mockGetObjectBuffer.mockResolvedValue(opts.buffer);
  return asset;
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe('OCR job end-to-end (#209)', () => {
  it('OCRs an image into markdownExtracted, units and ready', async () => {
    mockRecognizeImage.mockResolvedValue('HELLO FROM OCR');
    const asset = await seedAsset({
      filename: 'picture.png',
      contentType: 'image/png',
      buffer: pngOf(200, 200),
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id).select('markdownStatus markdownExtracted units');
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toBe('HELLO FROM OCR');
    expect(stored?.toObject().units).toEqual([
      { index: 1, label: 'Document', text: 'HELLO FROM OCR' },
    ]);
  });

  it('does NOT throw the "not convertible" guard for an image', async () => {
    mockRecognizeImage.mockResolvedValue('text');
    const asset = await seedAsset({
      filename: 'picture.png',
      contentType: 'image/png',
      buffer: pngOf(100, 100),
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const job = await AssetJob.findOne({ assetId: asset._id });
    expect(job?.status).toBe('done');
    expect(job?.lastError ?? null).toBeNull();
    expect(mockRecognizeImage).toHaveBeenCalledTimes(1);
  });

  it('runs thumbnail and OCR in one job when both are pending', async () => {
    mockRecognizeImage.mockResolvedValue('BOTH');
    const asset = await seedAsset({
      filename: 'both.png',
      contentType: 'image/png',
      buffer: pngOf(300, 300),
      thumbnailStatus: 'pending',
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toBe('BOTH');
    expect(stored?.thumbnailStatus).toBe('ready');
    expect(mockPutObject).toHaveBeenCalledTimes(1);
  });

  it('still produces the thumbnail when OCR fails (independent lifecycles)', async () => {
    mockRecognizeImage.mockResolvedValue('   ');
    const asset = await seedAsset({
      filename: 'blank-thumb.png',
      contentType: 'image/png',
      buffer: pngOf(300, 300),
      thumbnailStatus: 'pending',
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id);
    // Thumbnail succeeded despite the OCR failure; markdown is still pending
    // for retry (attempt 1 of 3), not lost.
    expect(stored?.thumbnailStatus).toBe('ready');
    expect(stored?.markdownStatus).toBe('pending');
    expect(mockPutObject).toHaveBeenCalledTimes(1);
  });

  it('marks a blank image failed with a reason instead of a success-looking empty', async () => {
    mockRecognizeImage.mockResolvedValue('   ');
    const asset = await seedAsset({
      filename: 'blank.png',
      contentType: 'image/png',
      buffer: pngOf(100, 100),
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    for (let i = 0; i < 3; i++) await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('failed');
    expect(stored?.markdownFailureReason).toBe('no text found by OCR');
  });

  it('skips OCR above the input cap and fails with the size reason', async () => {
    const huge = Buffer.alloc(OCR_MAX_INPUT_BYTES + 1);
    const asset = await seedAsset({
      filename: 'huge.png',
      contentType: 'image/png',
      buffer: huge,
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    for (let i = 0; i < 3; i++) await runAssetJobTick(processAssetConversionJob);

    expect(mockRecognizeImage).not.toHaveBeenCalled();
    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('failed');
    expect(stored?.markdownFailureReason).toBe('too large for OCR');
  });

  it('OCRs a scanned PDF page-by-page with -- n of n -- separators', async () => {
    // pdf-parse yields no text for the scanned fixture, so the fallback fires.
    const pageA = pngOf(100, 100);
    const pageB = pngOf(100, 100);
    mockRasterizePdf.mockResolvedValue({ pages: [pageA, pageB], totalPages: 2 });
    mockRecognizeImage
      .mockResolvedValueOnce('Page one words')
      .mockResolvedValueOnce('Page two words');

    const asset = await seedAsset({
      filename: 'scanned.pdf',
      contentType: 'application/pdf',
      buffer: fixture('scanned.pdf'),
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    expect(mockRasterizePdf).toHaveBeenCalledTimes(1);
    const stored = await Asset.findById(asset._id).select('markdownStatus markdownExtracted units');
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toContain('-- 1 of 2 --');
    expect(stored?.markdownExtracted).toContain('-- 2 of 2 --');
    // Units come out one per page via the existing pdfUnits splitter.
    expect(stored?.toObject().units).toEqual([
      { index: 1, label: 'Page 1', text: 'Page one words' },
      { index: 2, label: 'Page 2', text: 'Page two words' },
    ]);
  });

  it('never OCRs a born-digital PDF (keeps the text layer)', async () => {
    const asset = await seedAsset({
      filename: 'sample.pdf',
      contentType: 'application/pdf',
      buffer: fixture('sample.pdf'),
    });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    expect(mockRasterizePdf).not.toHaveBeenCalled();
    expect(mockRecognizeImage).not.toHaveBeenCalled();
    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toContain('Hello Tova');
  });
});
