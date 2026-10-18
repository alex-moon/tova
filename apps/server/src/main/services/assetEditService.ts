import type { AssetDocument } from '../models/Asset';
import { Asset } from '../models/Asset';
import { AssetVersion } from '../models/AssetVersion';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE } from './assetLimits';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

/* Shared content-write path; search/replace refuses ambiguous matches. */
// @see #325

export interface AssetEdit {
  oldText: string;
  newText: string;
}

export type AssetWriteCode =
  | 'invalid'
  | 'too_large'
  | 'no_match'
  | 'ambiguous'
  | 'no_change'
  | 'conflict'
  | 'not_found'
  | 'not_editable'
  | 'unavailable';

export type AssetWriteResult =
  { ok: true; asset: AssetDocument } | { ok: false; code: AssetWriteCode; message: string };

interface Match {
  readonly start: number;
  readonly end: number;
}

const crlf = '\r\n';
// tsconfig lib predates String.replaceAll; regex forms are equivalent.
const crlfRegex = /\r\n/g;
const crRegex = /\r/g;

const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');

const findOccurrences = (content: string, search: string) => {
  const result: Match[] = [];
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length });
    offset += search.length;
  }
  return result;
};

const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => {
      const newline = match[0].endsWith('\n');
      const text = newline ? match[0].slice(0, -1) : match[0];
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith('\r') ? 1 : 0),
        newline,
      };
    });
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length);
    if (actual.length !== expected.length) return [];
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) ===
          normalizeForMatch(expected[lineIndex]!.trimEnd()),
      )
    )
      return [];
    const last = actual[actual.length - 1]!;
    if (trailingNewline && !last.newline) return [];
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
  });
  // Overlapping candidates are distinct match starts, so they count for
  // ambiguity — collapsing them would let an ambiguous edit apply.
  // @see #396
  return candidates;
};

/** The dominant line ending in text, or fallback when there is none. */
const lineEnding = (text: string, fallback: string) => {
  const crlfCount = text.split(crlf).length - 1;
  const lfCount = text.split('\n').length - 1 - crlfCount;
  if (crlfCount === lfCount) return fallback;
  return crlfCount > lfCount ? crlf : '\n';
};

/** Joins replacement lines with endings from the matched region (LCS). */
const withRegionEndings = (region: string, replacement: string, fallback: string) => {
  const before = region.split(/\r?\n/);
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0]);
  const after = replacement.split('\n');
  const key = (line: string) => normalizeForMatch(line.trimEnd());
  const source = alignLines(before.map(key), after.map(key));
  return after
    .map((line, index) =>
      index === after.length - 1 ? line : line + (endings[source[index]!] ?? fallback),
    )
    .join('');
};

/** LCS map: `after` line index → kept `before` line, or undefined. */
const alignLines = (before: string[], after: string[]) => {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result: (number | undefined)[] = [];
  const gap = { before: [] as number[], after: [] as number[] };
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]));
    gap.before = [];
    gap.after = [];
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush();
      result[j++] = i++;
      continue;
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) gap.before.push(i++);
    else gap.after.push(j++);
  }
  while (i < before.length) gap.before.push(i++);
  while (j < after.length) gap.after.push(j++);
  flush();
  return result;
};

/** Matches the LF view `read_file` shows, then maps offsets back. */
const matchView = (source: string, oldText: string, newText: string) => {
  const view = source.replace(crlfRegex, '\n');
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
  const fileEnding = lineEnding(source, '\n');
  const search = oldText.replace(crlfRegex, '\n');
  const replacement = newText.replace(crlfRegex, '\n');
  const exact = findOccurrences(view, search);
  // These one-to-one mappings preserve offsets into the LF view.
  const unicode =
    exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search);
  return {
    matches: (exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing).map((match) => ({
      start: match.start + countBefore(removed, match.start),
      end: match.end + countBefore(removed, match.end),
    })),
    replace: (match: Match) => {
      const region = source.slice(match.start, match.end);
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding));
    },
  };
};

/** Number of sorted positions strictly before offset. */
const countBefore = (positions: number[], offset: number) => {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
};

// Pure matcher, exported for tests; `oldText` must occur exactly once.
export const applyEditsToContent = (
  content: string,
  edits: AssetEdit[],
):
  | {
      ok: true;
      content: string;
    }
  | { ok: false; code: 'no_match' | 'ambiguous' | 'no_change'; index: number } => {
  let next = content;
  for (let index = 0; index < edits.length; index += 1) {
    const { oldText, newText } = edits[index]!;
    // \r-only diffs target exact bytes; others match the LF view.
    const endingsOnly = oldText.replace(crRegex, '') === newText.replace(crRegex, '');
    const { matches, replace } = endingsOnly
      ? { matches: findOccurrences(next, oldText), replace: () => newText }
      : matchView(next, oldText, newText);
    if (matches.length === 0) return { ok: false, code: 'no_match', index };
    if (matches.length > 1) return { ok: false, code: 'ambiguous', index };
    const match = matches[0]!;
    const replaced = next.slice(0, match.start) + replace(match) + next.slice(match.end);
    if (replaced === next) return { ok: false, code: 'no_change', index };
    next = replaced;
  }
  return { ok: true, content: next };
};

const snapshotVersion = (asset: AssetDocument, version: number, text: string): Promise<unknown> =>
  AssetVersion.updateOne(
    { assetId: asset._id, version },
    {
      $set: {
        userId: asset.userId,
        filename: asset.filename,
        size: Buffer.byteLength(text, 'utf8'),
        textExtracted: text,
      },
    },
    { upsert: true },
  );

// Write `content` as the asset's next version; validation runs first.
export const writeAssetContent = async (
  asset: AssetDocument,
  content: string,
): Promise<AssetWriteResult> => {
  if (asset.origin !== 'system-generated') {
    return {
      ok: false,
      code: 'not_editable',
      message: 'Only assistant-generated files can be edited',
    };
  }
  if (!spacesWorkspaceStorage.isConfigured()) {
    return { ok: false, code: 'unavailable', message: 'File storage is not configured' };
  }
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length === 0) {
    return { ok: false, code: 'invalid', message: 'Edited file is empty' };
  }
  if (buffer.length > MAX_ASSET_SIZE) {
    return { ok: false, code: 'too_large', message: 'Edited file is too large (max 15 MB)' };
  }

  const currentVersion = asset.version ?? 1;
  // Legacy rows can predate the version field; seed it so the OCC filter
  // below can match. Concurrent seeds converge on the same value.
  // @see #396
  const seeded = await Asset.updateOne(
    { _id: asset._id, version: { $exists: false } },
    { $set: { version: currentVersion } },
  );
  if (seeded.modifiedCount) asset.version = currentVersion;

  // Snapshot the old content BEFORE the PUT: a crash mid-write leaves the
  // prior bytes recoverable from history.
  // @see #396
  await snapshotVersion(asset, currentVersion, asset.textExtracted ?? '');

  try {
    await spacesWorkspaceStorage.putByKey(asset.key, buffer, asset.contentType);
  } catch {
    return { ok: false, code: 'unavailable', message: 'Could not write the file to storage' };
  }

  // Optimistic concurrency: the row update is conditioned on the version
  // this edit was computed against; losing the race surfaces a conflict.
  // @see #396
  asset.textExtracted = content;
  asset.size = buffer.length;
  const updated = await Asset.updateOne(
    { _id: asset._id, version: currentVersion },
    { $set: { textExtracted: content, size: buffer.length, version: currentVersion + 1 } },
  );
  if (!updated.modifiedCount) {
    // Storage was clobbered by the loser: restore the surviving row's bytes,
    // but only while this edit is the immediate predecessor — a newer
    // winner's PUT is already authoritative, and a null text would blank it.
    // @see #396
    const winner = await Asset.findById(asset._id).select('textExtracted contentType version');
    if ((winner?.version ?? 1) === currentVersion + 1 && winner?.textExtracted != null) {
      await spacesWorkspaceStorage
        .putByKey(asset.key, Buffer.from(winner.textExtracted, 'utf8'), winner.contentType)
        .catch(() => undefined);
    }
    return {
      ok: false,
      code: 'conflict',
      message: 'The file changed while the edit was in flight. Re-read it and retry.',
    };
  }
  asset.version = currentVersion + 1;

  await snapshotVersion(asset, currentVersion + 1, content);

  enqueueWorkspaceEmbedding({
    userId: String(asset.userId),
    kind: 'file',
    sourceId: String(asset._id),
    source: { kind: 'file', filename: asset.filename, textExtracted: asset.textExtracted },
  });

  return { ok: true, asset };
};

export const applyAssetEdits = async (
  asset: AssetDocument,
  edits: AssetEdit[],
): Promise<AssetWriteResult> => {
  const result = applyEditsToContent(asset.textExtracted ?? '', edits);
  if (!result.ok) {
    const message =
      result.code === 'no_match'
        ? `Edit ${result.index + 1}: the text to replace was not found. Read the file and retry with its exact current text.`
        : result.code === 'no_change'
          ? `Edit ${result.index + 1}: oldText and newText are identical, so there is nothing to change. Adjust or drop that edit.`
          : `Edit ${result.index + 1}: the text to replace matches more than once. Include more surrounding text so the match is unique.`;
    return { ok: false, code: result.code, message };
  }
  return writeAssetContent(asset, result.content);
};

export const restoreAssetVersion = async (
  asset: AssetDocument,
  version: number,
): Promise<AssetWriteResult> => {
  if (asset.origin !== 'system-generated') {
    return {
      ok: false,
      code: 'not_editable',
      message: 'Only assistant-generated files can be edited',
    };
  }
  const row = await AssetVersion.findOne({
    assetId: asset._id,
    userId: asset.userId,
    version,
  }).select('textExtracted');
  if (!row) {
    return { ok: false, code: 'not_found', message: `Version ${version} not found` };
  }
  return writeAssetContent(asset, row.textExtracted ?? '');
};
