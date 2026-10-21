import { Asset } from '../models/Asset';
import type { AssetProvenance } from '../models/Asset';
import { spacesWorkspaceStorage } from './workspace/workspaceStorage';
import { MAX_ASSET_SIZE, isSafeFilename, sanitizeFilename } from './asset/assetLimits';
import { MAX_MARKDOWN_CHARS } from './markdownConversion';
import { enqueueWorkspaceEmbedding } from './workspace/workspaceEmbeddingIngest';
import { config } from '../config';

// Write path for system-generated assets in the user's library.
// @see #66
type CreateSystemAssetResult =
  | { ok: true; fileId: string; filename: string; size: number; createdAt: Date }
  | { ok: false; code: 'invalid' | 'too_large'; message: string };

// The generator emits markdown only; widen here if that changes.
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
  // Optional origin; omitted leaves provenance absent (unknown).
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
  if (!isSafeFilename(safeName)) {
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
  // The full buffer is the text; the 12k cap applies at assembly.
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

// Agent-side material (scraped pages): never in the library, native TTL.
// @see #340 #350
export const createSystemSideAsset = async (
  userId: string,
  filename: string,
  markdown: string,
  provenance?: AssetProvenance,
  sourceUrl?: string,
): Promise<{ fileId: string; filename: string } | null> => {
  // Store-time cap shared with every markdownExtracted producer.
  // @see #396
  const text = markdown.slice(0, MAX_MARKDOWN_CHARS);
  if (!text.trim()) return null;
  const safeName = sanitizeFilename(filename);
  if (!isSafeFilename(safeName)) return null;
  const ttlDays = config.agentAssets.ttlDays;
  const asset = await Asset.create({
    userId,
    filename: safeName,
    key: 'pending',
    contentType: 'text/markdown',
    size: Buffer.byteLength(text, 'utf8'),
    status: 'ready',
    origin: 'system-side',
    textExtracted: text,
    // Native TTL; 0 days disables expiry (field stays absent).
    // @see #340
    ...(ttlDays > 0 ? { expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(provenance ? { provenance } : {}),
  });
  // Synthetic key: never dereferenced, but the schema requires it.
  asset.key = `agent-side/${String(asset._id)}/${safeName}`;
  await asset.save();
  return { fileId: String(asset._id), filename: safeName };
};

// Reuse a fresh agent-side copy instead of re-scraping; exact match.
// ttlDays 0 means no expiry: any age is reusable, matching the write side.
// @see #340 #396
export const findFreshScrape = async (
  userId: string,
  sourceUrl: string,
): Promise<{ fileId: string; filename: string; content: string } | null> => {
  const ttlDays = config.agentAssets.ttlDays;
  const row = await Asset.findOne({
    userId,
    origin: 'system-side',
    status: 'ready',
    sourceUrl,
    ...(ttlDays > 0
      ? { createdAt: { $gte: new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000) } }
      : {}),
  });
  if (!row?.textExtracted) return null;
  return { fileId: String(row._id), filename: row.filename, content: row.textExtracted };
};
