import { readFileSync } from 'fs';
import { Types } from 'mongoose';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import {
  CONVERSION_TIMEOUT_MS,
  MAX_MARKDOWN_CHARS,
  convertToMarkdown,
  isConvertible,
  withTimeout,
} from './markdownConversion';
import { processAssetConversionJob } from './assetJobProcessor';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { runAssetJobTick } from './assetJobService';

const mockGetObjectBuffer = jest.fn();
const mockPutObject = jest.fn();

jest.mock('./storageService', () => ({
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

// Issue #67: real JS-native converters exercised against fixture files
// (mammoth for docx, pdf-parse for pdf, turndown for html) plus the failure
// and cap paths of the conversion service.

// Hardcoded fixture names only (typed strings — a test has no user input),
// joined with a template so no unbounded value feeds path.join().
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const fixture = (file: 'sample.pdf' | 'sample.docx' | 'sample.html'): Buffer =>
  readFileSync(`${FIXTURE_DIR}/${file}`);

// In-memory PNG for the #208 thumbnail path (no binary fixture to drift).
const pngOf = (width: number, height: number): Buffer => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366ff';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
};

describe('isConvertible (#67)', () => {
  it('accepts the v1 toolchain extensions and rejects the rest', () => {
    expect(isConvertible('a.pdf')).toBe(true);
    expect(isConvertible('B.DOCX')).toBe(true);
    expect(isConvertible('c.HTML')).toBe(true);
    expect(isConvertible('d.htm')).toBe(true);
    expect(isConvertible('no-extension')).toBe(false);
    expect(isConvertible('e.rtf')).toBe(false);
    expect(isConvertible('f.pptx')).toBe(false);
  });
});

describe('convertToMarkdown (#67)', () => {
  it('converts a PDF fixture', async () => {
    const markdown = await convertToMarkdown('sample.pdf', fixture('sample.pdf'));
    expect(markdown).toContain('Hello Tova');
  });

  it('converts a docx fixture', async () => {
    const markdown = await convertToMarkdown('sample.docx', fixture('sample.docx'));
    expect(markdown).toContain('Hello From Docx');
    expect(markdown).toContain('Body paragraph');
  });

  it('converts an HTML buffer to markdown', async () => {
    const markdown = await convertToMarkdown('sample.html', fixture('sample.html'));
    expect(markdown).toContain('# Html Fixture');
    expect(markdown).toContain('**bold**');
  });

  it('throws on unsupported extensions', async () => {
    await expect(convertToMarkdown('notes.rtf', Buffer.from('rtf!'))).rejects.toThrow(
      'unsupported conversion type: .rtf',
    );
    await expect(convertToMarkdown('image.png', Buffer.from('bin'))).rejects.toThrow(
      'unsupported conversion type: .png',
    );
  });

  it('throws on corrupted document input and on empty output', async () => {
    await expect(convertToMarkdown('broken.pdf', Buffer.from('not a pdf'))).rejects.toThrow();
    await expect(convertToMarkdown('empty.html', Buffer.from('<html></html>'))).rejects.toThrow(
      'empty markdown',
    );
  });

  it('truncates stored markdown at the storage cap', async () => {
    // The cap is enforced on the raw output length; craft an impossible PDF
    // is overkill, so exercise the trim through an oversized HTML doc.
    const big = Buffer.from(`<p>${'word '.repeat(MAX_MARKDOWN_CHARS)}</p>`);
    const markdown = await convertToMarkdown('big.html', big);
    expect(markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
  });

  it('shortens the timeout helper for hung converters', async () => {
    jest.useFakeTimers();
    const hung = new Promise<string>(() => undefined);
    const pending = withTimeout(hung, 5000);
    const assertion = expect(pending).rejects.toThrow(`conversion timed out after ${5000}ms`);
    jest.advanceTimersByTime(CONVERSION_TIMEOUT_MS + 6000);
    await assertion;
    jest.useRealTimers();
  });
});

describe('processAssetConversionJob (#67)', () => {
  const stubJob = (assetId: string): unknown => ({ assetId });

  it('bails out when the asset vanishes so the job loop settles the retry', async () => {
    await expect(
      processAssetConversionJob(stubJob('000000000000000000000000') as never),
    ).resolves.toBeUndefined();
  });
});

describe('conversion job end-to-end (#67)', () => {
  const seedAsset = async (filename: string, buffer: Buffer) => {
    const asset = await Asset.create({
      userId: new Types.ObjectId(),
      filename,
      key: 'u/a/' + filename,
      contentType: 'application/pdf',
      size: buffer.length,
      status: 'ready',
      markdownStatus: 'pending',
    });
    mockGetObjectBuffer.mockResolvedValue(buffer);
    return asset;
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('converts a queued pdf through the full job loop and stores the markdown', async () => {
    const asset = await seedAsset('sample.pdf', fixture('sample.pdf'));
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);
    const stored = await Asset.findById(asset._id).select('markdownStatus markdownExtracted units');
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toContain('Hello Tova');
    // #159: units persist alongside the markdown, one per PDF page. The real
    // pdf-parse separator is `\n-- n of n --\n` (verified against this
    // fixture), so page 1 is the text before the separator, and the trailing
    // blank lines after the final separator produce no phantom page.
    expect(stored?.toObject().units).toEqual([{ index: 1, label: 'Page 1', text: 'Hello Tova' }]);
  });

  it('a failed converter path returns through runAssetJobTick without touching the asset', async () => {
    const asset = await seedAsset('corrupt.pdf', Buffer.from('nope'));
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);
    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('pending');
    const job = await AssetJob.findOne({ assetId: asset._id });
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
  });
});

describe('thumbnail job end-to-end (#208)', () => {
  const seedImage = async (buffer: Buffer) => {
    const userId = new Types.ObjectId();
    const asset = await Asset.create({
      userId,
      filename: 'photo.png',
      key: 'u/a/photo.png',
      contentType: 'image/png',
      size: buffer.length,
      status: 'ready',
      thumbnailStatus: 'pending',
    });
    mockGetObjectBuffer.mockResolvedValue(buffer);
    return { asset, userId: String(userId) };
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('derives and stores a bounded thumbnail then marks it ready', async () => {
    const { asset, userId } = await seedImage(pngOf(1200, 600));
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id);
    expect(stored?.thumbnailStatus).toBe('ready');
    expect(stored?.thumbnailKey).toBe(`${userId}/${String(asset._id)}/thumbnail`);
    // No markdown path ran: the PNG is not a convertible document.
    expect(stored?.markdownStatus).toBe('none');

    const [key, body, contentType] = mockPutObject.mock.calls[0] as [string, Buffer, string];
    expect(key).toBe(`${userId}/${String(asset._id)}/thumbnail`);
    expect(contentType).toBe('image/png');
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('leaves a ready markdown untouched when only the thumbnail is pending', async () => {
    const { asset } = await seedImage(pngOf(40, 40));
    await Asset.updateOne({ _id: asset._id }, { $set: { markdownStatus: 'ready' } });
    await AssetJob.create({ assetId: asset._id, status: 'pending' });
    await runAssetJobTick(processAssetConversionJob);

    const stored = await Asset.findById(asset._id);
    expect(stored?.thumbnailStatus).toBe('ready');
    expect(stored?.markdownStatus).toBe('ready');
  });
});
