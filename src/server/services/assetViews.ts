import type { AssetDocument } from '../models/Asset';

const safeAsset = (asset: AssetDocument): unknown => ({
  id: String(asset._id),
  filename: asset.filename,
  contentType: asset.contentType,
  size: asset.size,
  status: asset.status,
  // lets the UI tell the user when no text could be extracted (issue #34
  // owner ask) — the extracted text itself stays server-side, never a
  // client-rendered payload.
  // Issue #83: markdown conversion output counts as text — align with the
  // chat read path (textExtracted ?? markdownExtracted) so library picks of
  // converted PDFs don't report a false "no text extracted".
  hasText: Boolean(asset.textExtracted ?? asset.markdownExtracted),
  // Issue #67: conversion lifecycle for the library UI badge; no markdown
  // text ever reaches the client.
  markdownStatus: asset.markdownStatus,
  // Issue #83: surface the worker's last failure reason for the failed-card
  // tooltip (metadata only — no markdown text content).
  markdownFailureReason: asset.markdownFailureReason ?? null,
  // Issue #208: thumbnail lifecycle so the library/viewer can wait for the
  // derived preview instead of loading the original. The key itself stays
  // server-side (only the presigned URL route reveals it).
  thumbnailStatus: asset.thumbnailStatus,
  createdAt: asset.createdAt,
});

// Issue #197: the in-app viewer needs the extracted body, which `safeAsset`
// deliberately omits. This view is only returned by the single-asset
// `GET /api/assets/:id/content` route (ownership-scoped) — never by the list.
// Precedence matches the chat read path (`textExtracted ?? markdownExtracted`):
// the fast UTF-8 path wins for txt/md/csv, converted markdown otherwise.
const previewAsset = (asset: AssetDocument): unknown => {
  const content = asset.textExtracted ?? asset.markdownExtracted ?? null;
  // Issue #197: a Markdown upload keeps its source in `textExtracted` (the
  // fast UTF-8 path) — it is still markdown and must be rendered, not shown
  // as literal text. Converted documents (markdownExtracted) are markdown too.
  // Everything else is plain text.
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
    // null when nothing was extracted — the viewer shows "(no extracted text)".
    content,
    // 'markdown' when the body is markdown (rendered), else 'text'.
    format,
    markdownStatus: asset.markdownStatus,
    markdownFailureReason: asset.markdownFailureReason ?? null,
    // Issue #208: the viewer renders an image thumbnail, not the original;
    // this tells it whether that thumbnail exists yet.
    thumbnailStatus: asset.thumbnailStatus,
    createdAt: asset.createdAt,
  };
};

export { safeAsset, previewAsset };
