// Light text extraction (issue #34): deterministic and fast only. txt/md/csv
// are decoded as UTF-8 (BOM stripped); everything else — including PDFs,
// which the owner deferred to a follow-up ticket — returns null ("no text
// extracted"). Decision is made from the filename extension so the
// client-provided contentType can disagree with the file's real type without
// changing behaviour.
const EXTRACTABLE_EXTENSIONS = new Set(['txt', 'md', 'csv']);

export const isExtractable = (filename: string): boolean =>
  EXTRACTABLE_EXTENSIONS.has(extensionOf(filename));

export const extractText = (filename: string, buf: Buffer): string | null => {
  if (!isExtractable(filename)) return null;
  return stripBom(buf.toString('utf8'));
};

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

const stripBom = (text: string): string => (text.startsWith('\ufeff') ? text.slice(1) : text);
