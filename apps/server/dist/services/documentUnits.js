"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractUnits = void 0;
const markdownConversion_1 = require("./markdownConversion");
const PDF_PAGE_LINE = /^-- (\d+) of (\d+) --$/gm;
const wholeDocUnit = (text) => [{ index: 1, label: 'Document', text }];
const isPdf = (filename) => (0, markdownConversion_1.extensionOf)(filename) === 'pdf';
const isHeaded = (filename) => ['md', 'html', 'htm'].includes((0, markdownConversion_1.extensionOf)(filename));
// PDFs: split on the `-- n of n --` separator lines pdf-parse appends after
// each page's text, so page n is the text between separators n-1 and n.
// PDFs that yield no separators fall back to a single whole-doc unit.
const pdfUnits = (markdown) => {
    var _a, _b, _c, _d;
    const matches = [...markdown.matchAll(PDF_PAGE_LINE)];
    if (matches.length === 0)
        return wholeDocUnit(markdown);
    const first = matches[0];
    const units = [
        {
            index: Number(first[1]),
            label: `Page ${first[1]}`,
            text: markdown.slice(0, (_a = first.index) !== null && _a !== void 0 ? _a : 0).trim(),
        },
    ];
    for (let i = 1; i < matches.length; i++) {
        const previous = matches[i - 1];
        const current = matches[i];
        const start = ((_b = previous.index) !== null && _b !== void 0 ? _b : 0) + previous[0].length;
        units.push({
            index: Number(current[1]),
            label: `Page ${current[1]}`,
            text: markdown.slice(start, (_c = current.index) !== null && _c !== void 0 ? _c : start).trim(),
        });
    }
    // Text after the final separator has no page label of its own (pdf-parse
    // ends each page with its separator): keep it as an extra page rather than
    // dropping it.
    const last = matches[matches.length - 1];
    const tail = markdown.slice(((_d = last.index) !== null && _d !== void 0 ? _d : 0) + last[0].length).trim();
    if (tail.length > 0) {
        units.push({ index: Number(last[1]) + 1, label: `Page ${Number(last[1]) + 1}`, text: tail });
    }
    return units;
};
const headingOf = (line) => {
    const match = /^(#{1,6}) (.+)$/.exec(line);
    return match ? { level: match[1].length, title: match[2].trim() } : null;
};
// ``` / ~~~~ fence lines toggle an open fence (the closing fence only ends it
// if it uses the same run of characters). Headings inside fenced code blocks
// are examples, not document structure, and must not drive the split — a
// doctored `# comment` inside a fence would otherwise become the shallowest
// heading level and collapse the whole document to a single unit.
const isFenceLine = (line) => /^(`{3,}|~{3,})/.test(line);
// md/html arrive as markdown (turndown for html): split on ATX headings at
// the shallowest level present (H1 if any, otherwise the shallowest used),
// so each unit is a top-level section titled by its heading. Anything
// before the first such heading — usually nothing — becomes an untitled
// leading unit. A document with no (or a single) split-level heading stays
// whole.
const headingUnits = (markdown) => {
    const lines = markdown.split('\n');
    const headings = [];
    let insideFence = false;
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        if (isFenceLine(lines[lineNo])) {
            insideFence = !insideFence;
            continue;
        }
        if (insideFence)
            continue;
        const heading = headingOf(lines[lineNo]);
        if (heading)
            headings.push(Object.assign({ lineNo }, heading));
    }
    if (headings.length === 0)
        return wholeDocUnit(markdown);
    const splitLevel = Math.min(...headings.map((h) => h.level));
    const starts = headings.filter((h) => h.level === splitLevel);
    if (starts.length <= 1)
        return wholeDocUnit(markdown);
    const sliceFromLines = (from, to) => lines.slice(from, to).join('\n').trim();
    const units = [];
    if (starts[0].lineNo > 0) {
        const preamble = sliceFromLines(0, starts[0].lineNo);
        if (preamble.length > 0)
            units.push({ index: 1, label: 'Document', text: preamble });
    }
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const to = i + 1 < starts.length ? starts[i + 1].lineNo : lines.length;
        units.push({
            index: units.length + 1,
            label: start.title,
            text: sliceFromLines(start.lineNo, to),
        });
    }
    if (units.length === 1)
        return wholeDocUnit(markdown);
    return units;
};
// Entry point: file-type dispatch, whole-doc fallback for docx/txt.
const extractUnits = (filename, markdown) => {
    if (isPdf(filename))
        return pdfUnits(markdown);
    if (isHeaded(filename))
        return headingUnits(markdown);
    return wholeDocUnit(markdown);
};
exports.extractUnits = extractUnits;
