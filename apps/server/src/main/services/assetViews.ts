import type { AssetDocument, AssetProvenance } from '../models/Asset';

const safeAsset = (asset: AssetDocument): unknown => ({
  id: String(asset._id),
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  status: asset.status,
  // File audience; lets the viewer hide affordances needing a Spaces object.
  // @see #340
  origin: asset.origin,
  // Current content version; > 1 means edit history exists.
  // @see #325
  version: asset.version ?? 1,
  // Absent provenance serialises as explicit null, never faked.
  // @see #252
  provenance: (asset.provenance as AssetProvenance | undefined) ?? null,
  // Lets the UI signal "no text extracted"; the text stays server-side.
  // @see #34
  // Converted markdown counts as text, matching the chat read path.
  // @see #83
  hasText: Boolean(asset.textExtracted ?? asset.markdownExtracted),
  // Conversion lifecycle for the library badge; no text reaches the client.
  // @see #67
  markdownStatus: asset.markdownStatus,
  // Worker's last failure reason, for the failed-card tooltip.
  // @see #83
  markdownFailureReason: asset.markdownFailureReason ?? null,
  // Thumbnail lifecycle so the viewer can wait for the derived preview.
  // @see #208
  thumbnailStatus: asset.thumbnailStatus,
  createdAt: asset.createdAt,
});

// The viewer needs the extracted body, which safeAsset omits by design.
// @see #197
const previewAsset = (asset: AssetDocument): unknown => {
  const content = asset.textExtracted ?? asset.markdownExtracted ?? null;
  // A Markdown upload keeps its source in textExtracted; render it.
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
    // The viewer hides object-backed actions for agent-side rows.
    // @see #340
    origin: asset.origin,
    // Current content version (see safeAsset).
    // @see #325
    version: asset.version ?? 1,
    // Same contract as `safeAsset` — explicit null when unknown.
    // @see #252
    provenance: (asset.provenance as AssetProvenance | undefined) ?? null,
    // null when nothing was extracted (viewer shows that state).
    content,
    // 'markdown' when the body is markdown (rendered), else 'text'.
    format,
    markdownStatus: asset.markdownStatus,
    markdownFailureReason: asset.markdownFailureReason ?? null,
    // The viewer renders a thumbnail, not the original; is it ready yet?
    // @see #208
    thumbnailStatus: asset.thumbnailStatus,
    createdAt: asset.createdAt,
  };
};

export { safeAsset, previewAsset };
