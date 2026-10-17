import { Asset } from '../models/Asset';
import type { AssetProvenance } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { MAX_ASSET_SIZE, sanitizeFilename } from './assetLimits';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';
import { config } from '../config';

// Server-side write path for system-generated assets placed in the user's library; owned by the requesting user so all normal asset paths work unchanged.
// @see #66
type CreateSystemAssetResult =
  | { ok: true; fileId: string; filename: string; size: number; createdAt: Date }
  | { ok: false; code: 'invalid' | 'too_large'; message: string };

// The generator emits markdown only; widening the family is a one-line change here.
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
  // Optional origin for the generated file; omitted means provenance is left absent (unknown), never defaulted.
  // @see #252
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
  // The full buffer is the text by construction; the 12k cap applies only at prompt-assembly time.
  const text = buffer.toString('utf8');
  asset.textExtracted = text || null;
  asset.status = 'ready';
  await asset.save();

  // Embed the generated file's text: fire-and-forget + flag-gated.
  // @see #294
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

// Agent-side material (e.g. a scraped page for read_file): never in the library or attach picker, no Spaces object, no embedding; expiry is a native TTL index.
// @see #340 #350
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
    // Native TTL; 0 days disables expiry — the field stays absent and TTL never fires.
    // @see #340
    ...(ttlDays > 0 ? { expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(provenance ? { provenance } : {}),
  });
  // Synthetic key: never dereferenced (no object exists), but the schema requires the field.
  asset.key = `agent-side/${String(asset._id)}/${safeName}`;
  await asset.save();
  return { fileId: String(asset._id), filename: safeName };
};

// Reuse a fresh agent-side copy of a URL instead of re-scraping; freshness horizon matches the TTL; exact-URL match.
// @see #340
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
