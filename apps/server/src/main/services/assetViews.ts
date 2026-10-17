import type { AssetDocument, AssetProvenance } from '../models/Asset';

const safeAsset = (asset: AssetDocument): unknown => ({
  id: String(asset._id),
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  status: asset.status,
  // Which audience the file is for; lets the viewer hide attach/download affordances that need a Spaces object.
  // @see #340
  origin: asset.origin,
  // Current content version; > 1 means the file has edit history the viewer can show.
  // @see #325
  version: asset.version ?? 1,
  // Absent provenance serialises as explicit null so "unknown" is distinguishable from "field missing"; never faked.
  // @see #252
  provenance: (asset.provenance as AssetProvenance | undefined) ?? null,
  // Lets the UI say when no text could be extracted; the extracted text itself stays server-side.
  // @see #34
  // Markdown conversion output counts as text, aligning with the chat read path so converted PDFs don't falsely report "no text".
  // @see #83
  hasText: Boolean(asset.textExtracted ?? asset.markdownExtracted),
  // Conversion lifecycle for the library UI badge; no markdown text ever reaches the client.
  // @see #67
  markdownStatus: asset.markdownStatus,
  // The worker's last failure reason for the failed-card tooltip (metadata only).
  // @see #83
  markdownFailureReason: asset.markdownFailureReason ?? null,
  // Thumbnail lifecycle so the library/viewer can wait for the derived preview; the key itself stays server-side.
  // @see #208
  thumbnailStatus: asset.thumbnailStatus,
  createdAt: asset.createdAt,
});

// The in-app viewer needs the extracted body, which safeAsset deliberately omits; only the single-asset content route returns it (ownership-scoped); precedence matches the chat read path.
// @see #197
const previewAsset = (asset: AssetDocument): unknown => {
  const content = asset.textExtracted ?? asset.markdownExtracted ?? null;
  // A Markdown upload keeps its source in textExtracted — still markdown and must be rendered, not shown as literal text; converted documents are markdown too.
  // @see #197
  const isMarkdownFile =
    asset.contentType === 'text/markdown' || /\.(md|markdown)$/i.test(asset.filename);
  const format =
    isMarkdownFile || (asset.textExtracted == null && asset.markdownExtracted != null)
      ? 'markdown'
      : 'text';
  return {
    id: String(asset._id),
    filename: asset.filename,
    contentType: asset.contentType,
    size: asset.size,
    status: asset.status,
    // The viewer hides object-backed actions for agent-side rows (no Spaces object at all).
    // @see #340
    origin: asset.origin,
    // Current content version (see safeAsset).
    // @see #325
    version: asset.version ?? 1,
    // Same contract as `safeAsset` — explicit null when unknown.
    // @see #252
    provenance: (asset.provenance as AssetProvenance | undefined) ?? null,
    // null when nothing was extracted — the viewer shows "(no extracted text)".
    content,
    // 'markdown' when the body is markdown (rendered), else 'text'.
    format,
    markdownStatus: asset.markdownStatus,
    markdownFailureReason: asset.markdownFailureReason ?? null,
    // The viewer renders an image thumbnail, not the original; this tells it whether that thumbnail exists yet.
    // @see #208
    thumbnailStatus: asset.thumbnailStatus,
    createdAt: asset.createdAt,
  };
};

export { safeAsset, previewAsset };
