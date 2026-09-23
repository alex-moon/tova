import { extensionOf } from './markdownConversion';

// Document units (issue #159): long documents are stored as a sequence of
// units — one per PDF page, one per top-level section for md/html — so the
// agent can walk through the extracted text unit by unit (e.g. "which page
// is the support phone number on?") instead of seeing only the head slice
// of the whole conversion. Units are additive to `markdownExtracted` and
// invisible to the user; they are derived by slicing the already-capped
// conversion output, so total stored size does not grow.
//
// Extraction is pure string work — the guideline lives in the agent-facing
// tool, not here.

export interface AssetUnit {
  // User-visible position (1-based).
  index: number;
  label: string;
  text: string;
}

const PDF_PAGE_LINE = /^-- (\d+) of (\d+) --$/gm;

const wholeDocUnit = (text: string): AssetUnit[] => [{ index: 1, label: 'Document', text }];

const isPdf = (filename: string): boolean => extensionOf(filename) === 'pdf';

const isHeaded = (filename: string): boolean =>
  ['md', 'html', 'htm'].includes(extensionOf(filename));

// PDFs: split on the `-- n of n --` separator lines pdf-parse appends after
// each page's text, so page n is the text between separators n-1 and n.
// PDFs that yield no separators fall back to a single whole-doc unit.
const pdfUnits = (markdown: string): AssetUnit[] => {
  const matches = [...markdown.matchAll(PDF_PAGE_LINE)];
  if (matches.length === 0) return wholeDocUnit(markdown);
  const first = matches[0]!;
  const units: AssetUnit[] = [
    {
      index: Number(first[1]),
      label: `Page ${first[1]}`,
      text: markdown.slice(0, first.index ?? 0).trim(),
    },
  ];
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1]!;
    const current = matches[i]!;
    const start = (previous.index ?? 0) + previous[0].length;
    units.push({
      index: Number(current[1]),
      label: `Page ${current[1]}`,
      text: markdown.slice(start, current.index ?? start).trim(),
    });
  }
  // Text after the final separator has no page label of its own (pdf-parse
  // ends each page with its separator): keep it as an extra page rather than
  // dropping it.
  const last = matches[matches.length - 1]!;
  const tail = markdown.slice((last.index ?? 0) + last[0].length).trim();
  if (tail.length > 0) {
    units.push({ index: Number(last[1]) + 1, label: `Page ${Number(last[1]) + 1}`, text: tail });
  }
  return units;
};

const headingOf = (line: string): { level: number; title: string } | null => {
  const match = /^(#{1,6}) (.+)$/.exec(line);
  return match ? { level: match[1]!.length, title: match[2]!.trim() } : null;
};

// ``` / ~~~~ fence lines toggle an open fence (the closing fence only ends it
// if it uses the same run of characters). Headings inside fenced code blocks
// are examples, not document structure, and must not drive the split — a
// doctored `# comment` inside a fence would otherwise become the shallowest
// heading level and collapse the whole document to a single unit.
const isFenceLine = (line: string): boolean => /^(`{3,}|~{3,})/.test(line);

// md/html arrive as markdown (turndown for html): split on ATX headings at
// the shallowest level present (H1 if any, otherwise the shallowest used),
// so each unit is a top-level section titled by its heading. Anything
// before the first such heading — usually nothing — becomes an untitled
// leading unit. A document with no (or a single) split-level heading stays
// whole.
const headingUnits = (markdown: string): AssetUnit[] => {
  const lines = markdown.split('\n');
  const headings: { lineNo: number; level: number; title: string }[] = [];
  let insideFence = false;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (isFenceLine(lines[lineNo]!)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const heading = headingOf(lines[lineNo]!);
    if (heading) headings.push({ lineNo, ...heading });
  }
  if (headings.length === 0) return wholeDocUnit(markdown);
  const splitLevel = Math.min(...headings.map((h) => h.level));
  const starts = headings.filter((h) => h.level === splitLevel);
  if (starts.length <= 1) return wholeDocUnit(markdown);
  const sliceFromLines = (from: number, to: number): string =>
    lines.slice(from, to).join('\n').trim();
  const units: AssetUnit[] = [];
  if (starts[0]!.lineNo > 0) {
    const preamble = sliceFromLines(0, starts[0]!.lineNo);
    if (preamble.length > 0) units.push({ index: 1, label: 'Document', text: preamble });
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]!.lineNo : lines.length;
    units.push({
      index: units.length + 1,
      label: start.title,
      text: sliceFromLines(start.lineNo, to),
    });
  }
  if (units.length === 1) return wholeDocUnit(markdown);
  return units;
};

// Entry point: file-type dispatch, whole-doc fallback for docx/txt.
export const extractUnits = (filename: string, markdown: string): AssetUnit[] => {
  if (isPdf(filename)) return pdfUnits(markdown);
  if (isHeaded(filename)) return headingUnits(markdown);
  return wholeDocUnit(markdown);
};
