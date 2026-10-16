import { dedupeEntryNames, sanitizeZipEntryName } from '../../main/services/assetZip';

describe('sanitizeZipEntryName', () => {
  it('keeps ordinary filenames untouched', () => {
    expect(sanitizeZipEntryName('report 2026.pdf')).toBe('report 2026.pdf');
  });

  it('replaces path separators so entries cannot escape the archive', () => {
    expect(sanitizeZipEntryName('docs/secret.txt')).toBe('docs_secret.txt');
    expect(sanitizeZipEntryName('docs\\secret.txt')).toBe('docs_secret.txt');
  });

  it('strips control characters and DEL', () => {
    expect(sanitizeZipEntryName('a\u0001\u007fb.txt')).toBe('ab.txt');
  });

  it('falls back to unnamed.bin for whitespace-only names', () => {
    expect(sanitizeZipEntryName('   ')).toBe('unnamed.bin');
  });
});

describe('dedupeEntryNames', () => {
  it('keeps first-seen names and appends (n) on collisions', () => {
    expect(dedupeEntryNames(['a.txt', 'a.txt', 'a.txt'])).toEqual([
      'a.txt',
      'a (2).txt',
      'a (3).txt',
    ]);
  });

  it('applies (n) before the extension', () => {
    expect(dedupeEntryNames(['log', 'log'])).toEqual(['log', 'log (2)']);
  });

  it('does not treat a leading dot as an extension', () => {
    expect(dedupeEntryNames(['.hidden', '.hidden'])).toEqual(['.hidden', '.hidden (2)']);
  });

  it('collides on the sanitized form, not the raw name', () => {
    expect(dedupeEntryNames(['a/b.txt', 'a\\b.txt'])).toEqual(['a_b.txt', 'a_b (2).txt']);
  });
});
