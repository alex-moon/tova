import { extractUnits } from './documentUnits';

// Issue #159: units slice the already-capped conversion output per PDF page
// or per top-level heading, falling back to a single whole-doc unit.

describe('extractUnits — PDF (#159)', () => {
  it('splits on pdf-parse page separators so unit n is page n', () => {
    const markdown = 'alpha\n-- 1 of 3 --\nbeta\n-- 2 of 3 --\ngamma\n-- 3 of 3 --\n';
    expect(extractUnits('doc.pdf', markdown)).toEqual([
      { index: 1, label: 'Page 1', text: 'alpha' },
      { index: 2, label: 'Page 2', text: 'beta' },
      { index: 3, label: 'Page 3', text: 'gamma' },
    ]);
  });

  it('keeps text after the last separator as an extra page rather than dropping it', () => {
    const markdown = 'alpha\n-- 1 of 1 --\ntrailing';
    expect(extractUnits('doc.pdf', markdown)).toEqual([
      { index: 1, label: 'Page 1', text: 'alpha' },
      { index: 2, label: 'Page 2', text: 'trailing' },
    ]);
  });

  it('falls back to a whole-doc unit when no separators appear', () => {
    const markdown = 'just some text\nwithout separators';
    expect(extractUnits('doc.pdf', markdown)).toEqual([
      { index: 1, label: 'Document', text: markdown },
    ]);
  });

  it('tolerates separator-shaped lines inside page text via anchoring', () => {
    const markdown = 'see -- 9 of 99 inline\n-- 1 of 2 --\ntext two\n-- 2 of 2 --\nend';
    const units = extractUnits('doc.pdf', markdown);
    // The inline `-- 9 of 99` inside page text is not a separator (anchoring),
    // so only the two line-anchored ones split the document.
    expect(units).toHaveLength(3);
    expect(units[0].text).toBe('see -- 9 of 99 inline');
    expect(units[1]).toEqual({ index: 2, label: 'Page 2', text: 'text two' });
    expect(units[2]).toEqual({ index: 3, label: 'Page 3', text: 'end' });
  });
});

describe('extractUnits — headings (#159)', () => {
  it('splits markdown at the shallowest heading level', () => {
    const markdown = [
      'intro',
      '# One',
      'body one',
      '## Deep',
      'still one',
      '# Two',
      'body two',
    ].join('\n');
    expect(extractUnits('doc.md', markdown)).toEqual([
      { index: 1, label: 'Document', text: 'intro' },
      { index: 2, label: 'One', text: '# One\nbody one\n## Deep\nstill one' },
      { index: 3, label: 'Two', text: '# Two\nbody two' },
    ]);
  });

  it('uses the shallowest present level when there is no H1', () => {
    const markdown = ['pre', '## A', 'a', '## B', 'b', '### Sub', 'b2'].join('\n');
    const units = extractUnits('doc.md', markdown);
    expect(units.map((u) => u.label)).toEqual(['Document', 'A', 'B']);
  });

  it('keeps a single-section document whole', () => {
    const markdown = '# Only\nbody';
    expect(extractUnits('doc.md', markdown)).toEqual([
      { index: 1, label: 'Document', text: '# Only\nbody' },
    ]);
  });

  it('keeps heading-free markdown whole', () => {
    expect(extractUnits('doc.md', 'plain text\nmore')).toEqual([
      { index: 1, label: 'Document', text: 'plain text\nmore' },
    ]);
  });

  it('splits html via the same markdown path (turndown output)', () => {
    const markdown = ['# A', 'a', '# B', 'b'].join('\n');
    expect(extractUnits('page.htm', markdown)).toEqual([
      { index: 1, label: 'A', text: '# A\na' },
      { index: 2, label: 'B', text: '# B\nb' },
    ]);
  });
});

describe('extractUnits — other types (#159)', () => {
  it('gives docx and txt a single whole-doc unit', () => {
    for (const filename of ['report.docx', 'notes.txt', 'weird']) {
      expect(extractUnits(filename, 'whatever')).toEqual([
        { index: 1, label: 'Document', text: 'whatever' },
      ]);
    }
  });
});
