"use strict";
// Bulk-download zip-entry helpers: entry names come from stored
// Asset.filename (sanitized at presign), with a defensive second pass.
// Collisions get `name (2).ext`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.dedupeEntryNames = exports.sanitizeZipEntryName = void 0;
const sanitizeZipEntryName = (filename) => {
    const cleaned = filename
        .split('')
        .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
        .join('')
        .replace(/[/\\]/g, '_')
        .trim();
    return cleaned || 'unnamed.bin';
};
exports.sanitizeZipEntryName = sanitizeZipEntryName;
const dedupeEntryNames = (filenames) => {
    const counts = new Map();
    return filenames.map((filename) => {
        var _a;
        const name = sanitizeZipEntryName(filename);
        const seen = (_a = counts.get(name)) !== null && _a !== void 0 ? _a : 0;
        counts.set(name, seen + 1);
        if (seen === 0)
            return name;
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        return `${base} (${seen + 1})${ext}`;
    });
};
exports.dedupeEntryNames = dedupeEntryNames;
