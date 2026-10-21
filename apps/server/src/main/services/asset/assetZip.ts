// Zip-entry helpers: stored filenames, defensively; collisions dedupe.
// @see #396

import { isSafeFilename, sanitizeFilename } from './assetLimits';

const sanitizeZipEntryName = (filename: string): string => {
  const cleaned = sanitizeFilename(filename);
  return isSafeFilename(cleaned) ? cleaned : 'unnamed.bin';
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
