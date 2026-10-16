import { Asset } from '../models/Asset';
import type { AssetProvenance } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE, sanitizeFilename } from './assetLimits';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';
import { config } from '../config';

// Server-side write path for system-generated assets (issue #66): Tova
// itself creates a file (currently markdown only) and puts it in the user's
// asset library alongside uploads. Owned by the requesting user, so list /
// read / delete / attach paths work unchanged; `origin` records provenance.
type CreateSystemAssetResult =
  | { ok: true; fileId: string; filename: string; size: number; createdAt: Date }
  | { ok: false; code: 'invalid' | 'too_large'; message: string };

// The generator emits markdown files only for now (`text/markdown`; the
// alias stays accepted because presign has always allowed it). Widening the
// family (plain text, code execution output) is a one-line change here since
// the full upload allowlist intentionally stays out of this stricter path.
const SYSTEM_ALLOWED_CONTENT_TYPES = new Set(['text/markdown', 'text/x-markdown']);

const fail = (code: 'invalid' | 'too_large', message: string): CreateSystemAssetResult => ({
  ok: false,
  code,
  message,
});

export const createSystemAsset = async (
  userId: string,
  filename: string,
  buffer: Buffer,
  contentType: string,
  // #252: optional origin for the generated file. Trailing/optional so every
  // existing call site keeps compiling. Omitted means provenance is left
  // absent (unknown) — never defaulted.
  provenance?: AssetProvenance,
): Promise<CreateSystemAssetResult> => {
  if (!SYSTEM_ALLOWED_CONTENT_TYPES.has(contentType)) {
    return fail('invalid', `Content type ${contentType} is not allowed for generated files`);
  }
  if (buffer.length === 0) {
    return fail('invalid', 'Generated file is empty');
  }
  if (buffer.length > MAX_ASSET_SIZE) {
    return fail('too_large', 'Generated file is too large (max 15 MB)');
  }

  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    return fail('invalid', 'Generated filename is invalid');
  }

  const asset = await Asset.create({
    userId,
    filename: safeName,
    key: 'pending',
    contentType,
    size: buffer.length,
    status: 'pending',
    origin: 'system-generated',
    ...(provenance ? { provenance } : {}),
  });
  const key = `${userId}/${asset._id}/${safeName}`;

  try {
    await spacesWorkspaceStorage.putByKey(key, buffer, contentType);
  } catch (err) {
    asset.status = 'failed';
    asset.failureReason = 'storage-error';
    await asset.save();
    throw err;
  }

  asset.key = key;
  // The full buffer is the text by construction; no extraction step needed.
  // Per OQ4 the FULL text is stored — the 12k cap applies only at
  // prompt-assembly time (truncateForPrompt there, not here).
  const text = buffer.toString('utf8');
  asset.textExtracted = text || null;
  asset.status = 'ready';
  await asset.save();

  // #294: embed the generated file's text. Fire-and-forget + flag-gated.
  enqueueWorkspaceEmbedding({
    userId,
    kind: 'file',
    sourceId: String(asset._id),
    source: { kind: 'file', filename: asset.filename, textExtracted: asset.textExtracted },
  });

  return {
    ok: true,
    fileId: String(asset._id),
    filename: asset.filename,
    size: asset.size,
    createdAt: asset.createdAt as Date,
  };
};

// #340: agent-side material — e.g. a scraped web page saved so `read_file`
// can page through it (#350). Unlike system-generated files these are never
// shown in the library (the assets view lists them only behind its explicit
// `?origin=system-side` filter) and never offered to the attach picker. So
// unlike the path above there is no Spaces object (read_file reads the stored
// text; the row is not attachable, downloadable or editable) and no workspace
// embedding (web content is not the user's knowledge). Expiry is native:
// the row carries `expiresAt` and the TTL index deletes it — invisibility
// costs the user no management burden they didn't opt into, since the
// agent-side filter/tab exposes inspect + delete anyway.
export const createSystemSideAsset = async (
  userId: string,
  filename: string,
  markdown: string,
  provenance?: AssetProvenance,
  sourceUrl?: string,
): Promise<{ fileId: string; filename: string } | null> => {
  if (!markdown.trim()) return null;
  const safeName = sanitizeFilename(filename);
  if (!safeName) return null;
  const ttlDays = config.agentAssets.ttlDays;
  const asset = await Asset.create({
    userId,
    filename: safeName,
    key: 'pending',
    contentType: 'text/markdown',
    size: Buffer.byteLength(markdown, 'utf8'),
    status: 'ready',
    origin: 'system-side',
    textExtracted: markdown,
    // Native TTL (index on expiresAt, expireAfterSeconds: 0). 0 days disables
    // expiry — the field stays absent and TTL never fires for the row.
    ...(ttlDays > 0 ? { expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(provenance ? { provenance } : {}),
  });
  // Synthetic key: never dereferenced (no object exists), but the schema
  // requires the field and views surface it.
  asset.key = `agent-side/${String(asset._id)}/${safeName}`;
  await asset.save();
  return { fileId: String(asset._id), filename: safeName };
};

// #340: reuse a fresh agent-side copy of a URL instead of paying for a
// re-scrape. The freshness horizon matches the TTL — past it the row is (or
// soon is) expired and "something might well have changed", so the next
// fetch re-downloads. Exact-URL match: trivially different URLs (trailing
// slash, query variants) are distinct cache keys.
export const findFreshScrape = async (
  userId: string,
  sourceUrl: string,
): Promise<{ fileId: string; filename: string; content: string } | null> => {
  const ttlDays = config.agentAssets.ttlDays;
  if (!ttlDays) return null;
  const row = await Asset.findOne({
    userId,
    origin: 'system-side',
    status: 'ready',
    sourceUrl,
    createdAt: { $gte: new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000) },
  });
  if (!row?.textExtracted) return null;
  return { fileId: String(row._id), filename: row.filename, content: row.textExtracted };
};
