import { readFileSync } from 'fs';
import { Types } from 'mongoose';
import path from 'path';
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

jest.mock('./storageService', () => ({
  getObjectBuffer: (...args: unknown[]) => mockGetObjectBuffer(...args),
}));

// Issue #67: real JS-native converters exercised against fixture files
// (mammoth for docx, pdf-parse for pdf, turndown for html) plus the failure
// and cap paths of the conversion service.

const fixture = (file: string): Buffer => readFileSync(path.join(__dirname, 'fixtures', file));

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
    const stored = await Asset.findById(asset._id);
    expect(stored?.markdownStatus).toBe('ready');
    expect(stored?.markdownExtracted).toContain('Hello Tova');
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
