import type { AssetDocument } from '../models/Asset';
import { AssetVersion } from '../models/AssetVersion';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE } from './assetLimits';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

/*
 * #325: the content-write path for assistant-generated assets. `generate_file`
 * only ever creates a new asset; this is the first mutation-of-content path.
 * Both the `edit_file` tool and the restore route go through `writeAssetContent`
 * so versioning, the Spaces overwrite, and the embedding re-ingest cannot drift
 * between the two.
 *
 * Search/replace is deliberately verbatim (no regex): the model has the file's
 * exact text from `read_file`, and an exact, unique match gives clean typed
 * failures (`no_match` / `ambiguous`) it can retry. Edits apply sequentially so
 * a later edit sees an earlier one's output.
 */

export interface AssetEdit {
  oldText: string;
  newText: string;
}

export type AssetWriteCode =
  'invalid' | 'too_large' | 'no_match' | 'ambiguous' | 'not_found' | 'not_editable' | 'unavailable';

export type AssetWriteResult =
  { ok: true; asset: AssetDocument } | { ok: false; code: AssetWriteCode; message: string };

// Pure matcher, exported for unit testing. Applies each edit in order against
// the running content; `oldText` must occur exactly once (a repeated match is
// refused rather than silently editing the wrong occurrence).
export const applyEditsToContent = (
  content: string,
  edits: AssetEdit[],
): { ok: true; content: string } | { ok: false; code: 'no_match' | 'ambiguous'; index: number } => {
  let next = content;
  for (let index = 0; index < edits.length; index += 1) {
    const { oldText, newText } = edits[index]!;
    const first = next.indexOf(oldText);
    if (first === -1) return { ok: false, code: 'no_match', index };
    if (next.indexOf(oldText, first + oldText.length) !== -1) {
      return { ok: false, code: 'ambiguous', index };
    }
    next = next.slice(0, first) + newText + next.slice(first + oldText.length);
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

// Write `content` as the asset's next version. Snapshots the pre-write version
// and the new version, overwrites the Spaces object at the (unchanged) key, and
// re-runs the embedding ingest — exactly the downstream effects a fresh
// generate has. Validation runs before any state is touched.
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

  try {
    await spacesWorkspaceStorage.putByKey(asset.key, buffer, asset.contentType);
  } catch {
    return { ok: false, code: 'unavailable', message: 'Could not write the file to storage' };
  }

  const currentVersion = asset.version ?? 1;
  await snapshotVersion(asset, currentVersion, asset.textExtracted ?? '');

  asset.textExtracted = content;
  asset.size = buffer.length;
  asset.version = currentVersion + 1;
  await asset.save();

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
