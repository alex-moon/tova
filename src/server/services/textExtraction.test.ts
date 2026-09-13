import { extractText, isExtractable } from './textExtraction';

describe('textExtraction', () => {
  it('extracts UTF-8 text for txt', () => {
    expect(extractText('notes.txt', Buffer.from('hello world'))).toBe('hello world');
  });

  it('extracts UTF-8 text for md and csv', () => {
    expect(extractText('README.md', Buffer.from('# title'))).toBe('# title');
    expect(extractText('data.csv', Buffer.from('a,b\n1,2'))).toBe('a,b\n1,2');
  });

  it('matches extensions case-insensitively', () => {
    expect(extractText('NOTES.TXT', Buffer.from('hi'))).toBe('hi');
    expect(isExtractable('Report.CSV')).toBe(true);
  });

  it('returns null for non-text types including PDF', () => {
    expect(extractText('doc.pdf', Buffer.from('%PDF-1.4'))).toBeNull();
    expect(extractText('image.png', Buffer.from([0x89, 0x50]))).toBeNull();
    expect(extractText('noext', Buffer.from('x'))).toBeNull();
  });

  it('treats a lying filename as extractable by extension (deterministic rule)', () => {
    // The extraction decision is extension-based only: an .md file that is
    // really binary decodes lossily but never crashes or blocks the turn.
    expect(extractText('claims.md', Buffer.from([0xff, 0xfe]))).not.toBeNull();
  });

  it('strips a UTF-8 BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(extractText('bom.txt', buf)).toBe('hi');
  });
});
