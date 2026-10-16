// Bulk-download zip-entry helpers: entry names come from stored
// Asset.filename (sanitized at presign), with a defensive second pass.
// Collisions get `name (2).ext`.

const sanitizeZipEntryName = (filename: string): string => {
  const cleaned = filename
    .split('')
    .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
  return cleaned || 'unnamed.bin';
};

const dedupeEntryNames = (filenames: string[]): string[] => {
  const counts = new Map<string, number>();
  return filenames.map((filename) => {
    const name = sanitizeZipEntryName(filename);
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    if (seen === 0) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base} (${seen + 1})${ext}`;
  });
};

export { sanitizeZipEntryName, dedupeEntryNames };
