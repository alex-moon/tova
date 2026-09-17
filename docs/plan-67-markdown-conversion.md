# Plan: #67 — Convert files to markdown on upload

Part of #64's asset work. Status: implementing in this pass.

## Decisions on the open questions

- **OQ1 (tool): JS-native library stack, not markitdown.** markitdown is Python — a Node
  server would need a subprocess plus a Python runtime in every deploy/CI environment.
  `mammoth` (docx), `pdf-parse` (PDF, pdf.js based) and `turndown` (HTML → markdown)
  cover the v1 target formats with zero new infrastructure. markitdown stays open as a
  fallback only if conversion quality proves insufficient in manual review.
- **OQ2 (scope): `pdf`, `docx`, `html`/`htm` for v1.** rtf and pptx are deferred.
- **OQ3 (infra): zero new services.** Mongo-backed job collection (`assetJobs`) polled
  in-process by a small `setInterval` poller. No Redis/BullMQ, no Python sidecar.
- **OQ4 (surface): server-side only.** The markdown is stored for search/attach; the
  client receives a `markdownStatus` badge ('none'|'pending'|'ready'|'failed') on
  `AssetSummary`, never the markdown text itself (content stays server-side per #34).
- **OQ5 (inline vs worker): worker from the start.** `/confirm` keeps its latency
  promise; convertible uploads get `markdownStatus: 'pending'` and a queued job.
- **OQ6 (1 MB cap): raised for the conversion path only.** The fast-path extraction
  keeps `MAX_EXTRACT_BYTES = 1 MB`; conversion jobs call `getObjectBuffer` with a
  raised cap equal to the asset cap (15 MB, full buffer, matching the upload limit).
  Blocking a MB-scale download per job is acceptable at current scale.

## Design

### Job mechanism (Mongo-backed, chosen above)

`AssetJob` (models/AssetJob.ts): `assetId`, `status`
(`pending|processing|done|failed`), `attempts`, `lastError`, timestamps, index
`{ status: 1, createdAt: 1 }`.

`assetJobService.ts`:
- `enqueueAssetJob(assetId)` — idempotent while a job is live; a failed chain gets a
  fresh job.
- `claimNextAssetJob()` — atomic `pending → processing` claim + `attempts` bump,
  oldest-first.
- `runAssetJobTick(processor)` — claim, run processor, settle: success → `done`;
  failure → requeue until `MAX_JOB_ATTEMPTS` (3), then `failed` and asset
  `markdownStatus: 'failed'` + `markdownFailureReason` (asset itself stays `ready`).
- Stale `processing` sweep on poller start (5 min cutoff, attempts not charged) so a
  crash mid-job self-heals on restart.
- poller: single in-process consumer, one job per tick, skip while a run is in
  flight, interval 5 s, unref'd handle.

### Conversion service

`markdownConversion.ts`: `convertToMarkdown(filename, buffer)` with a per-extension
toolchain — pdf → `PDFParse.getText()`, docx → `mammoth.convertToMarkdown`,
html/htm → `turndown`. Unknown extension, empty result or converter error → throw
(retries applies). Caps: conversion input == the 15 MB asset cap; output stored
capped at `MAX_MARKDOWN_CHARS = 200_000` chars. Each conversion runs under a
`withTimeout` guard so a hung parser cannot wedge the poller.

### Confirm path / flow

`/confirm` unchanged for txt/md/csv (fast path). For filenames with a convertible
extension (pdf/docx/html/htm) and no fast-path text, confirm sets
`markdownStatus: 'pending'` and enqueues a job, then responds immediately as today.
Presign allowlist gains `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
and `text/html` so the new formats can actually be uploaded.

### Processor wiring

`startServer` starts the poller with the real processor (skipped under `NODE_ENV=
test`): fetch buffer via `getObjectBuffer`, convert, store markdown, set fields.
Success clears stale `markdownFailureReason`.

### Attach/search

`textExtracted ?? markdownExtracted` is the attach/read source (chat route envelope
and `readFileTool`), with the same 12k prompt cap applied at use time. Library UI gets
`markdownStatus` on `AssetSummary` for a "converted" badge.

## Tests

- Conversion service: pdf + docx fixtures (`fixtures/*.pdf`, `fixtures/*.docx`), html
  string, unknown extension, over-cap truncation, timeout guard.
- Queue: enqueue/claim/retry-cap/terminal-fail/stale-requeue/poller lifecycle.
- Confirm: convertible upload enqueues + sets `pending`; attachment attach test:
  markdown falls back into the envelope when no fast-path text.

## Out of scope (deferred)

- rtf/pptx conversion, markitdown fallback, end-user-facing markdown preview in the
  library UI, client-side webpack of converter libs.
