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
  createdAt: asset.createdAt,
});

export { safeAsset };
