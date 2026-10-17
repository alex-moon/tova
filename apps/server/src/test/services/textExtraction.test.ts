import {
  extractText,
  isExtractable,
  MAX_PROMPT_TEXT_CHARS,
  truncateForPrompt,
} from '../../main/services/textExtraction';

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
    // The extraction decision is extension-based only: an .md file that is really binary decodes lossily but never crashes or blocks the turn.
    // @see #34
    expect(extractText('claims.md', Buffer.from([0xff, 0xfe]))).not.toBeNull();
  });

  it('strips a UTF-8 BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(extractText('bom.txt', buf)).toBe('hi');
  });
});

describe('truncateForPrompt', () => {
  it('returns text unchanged under the cap', () => {
    expect(truncateForPrompt('hello')).toBe('hello');
  });

  it('truncates with a marker over the cap', () => {
    const long = 'a'.repeat(MAX_PROMPT_TEXT_CHARS + 50);
    const result = truncateForPrompt(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('truncated 50 characters');
    expect(result.startsWith('a'.repeat(MAX_PROMPT_TEXT_CHARS))).toBe(true);
  });
});
