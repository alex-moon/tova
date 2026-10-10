"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truncateForPrompt = exports.MAX_PROMPT_TEXT_CHARS = exports.extractText = exports.isExtractable = void 0;
// Light text extraction (issue #34): deterministic and fast only. txt/md/csv
// are decoded as UTF-8 (BOM stripped); everything else — including PDFs,
// which the owner deferred to a follow-up ticket — returns null ("no text
// extracted"). Decision is made from the filename extension so the
// client-provided contentType can disagree with the file's real type without
// changing behaviour.
const EXTRACTABLE_EXTENSIONS = new Set(['txt', 'md', 'csv']);
const isExtractable = (filename) => EXTRACTABLE_EXTENSIONS.has(extensionOf(filename));
exports.isExtractable = isExtractable;
const extractText = (filename, buf) => {
    if (!(0, exports.isExtractable)(filename))
        return null;
    return stripBom(buf.toString('utf8'));
};
exports.extractText = extractText;
// Cap applied at prompt-inclusion time (issue #34): extraction stores the
// decoded text, but the attached block pasted into the prompt never carries
// more than MAX_PROMPT_TEXT_CHARS so a huge CSV cannot blow the context.
exports.MAX_PROMPT_TEXT_CHARS = 12000;
const truncateForPrompt = (text, max = exports.MAX_PROMPT_TEXT_CHARS) => {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}\n[...truncated ${text.length - max} characters...]`;
};
exports.truncateForPrompt = truncateForPrompt;
const extensionOf = (filename) => {
    const dot = filename.lastIndexOf('.');
    return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};
const stripBom = (text) => (text.startsWith('\ufeff') ? text.slice(1) : text);
