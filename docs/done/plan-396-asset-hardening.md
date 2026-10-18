# Plan 396 — asset pipeline hardening batch

## Motivation

[#396](https://github.com/alex-moon/tova/issues/396), from the #382 audit: the asset
pipeline is roster-free and authz-clean but has hardening gaps across the worker,
presign/confirm lifecycle, routes, and media processing. 16 items; all addressed here
unless noted under Follow-ups.

## Decisions

- **Scope**: all 16 audit items land in this one batch, matching the shape of the
  sibling batches (#394, #395, #397). No drive-by refactors beyond them.
- **Worker lease (items 1, 10, 11, 12)**: mirror the #395 task pattern — `leaseToken`
  on `AssetJob`, rotated at claim; settle writes guarded by the lease so a frozen twin
  (stale-swept mid-run) writes nothing. The processor wrapper heartbeats `updatedAt`
  (60s) so long legitimate OCR (up to ~100 min for 50 pages) survives the 5-min sweep.
  The stale sweep now bumps `attempts` and terminal-fails jobs at the cap instead of
  recycling them forever. Claim errors are logged, not swallowed. Lifecycle errors are
  attributed per-lifecycle (markdown error preferred for `markdownFailureReason`),
  instead of first-error-wins.
- **Pending-row lifecycle (items 3, 8)**: pending presign rows get `expiresAt` (2h,
  outliving the 1h confirm window) — the existing TTL index reclaims them; confirm
  clears `expiresAt` on success. A new `sweepStalePendingAssets` (own interval, wired in
  `index.ts` next to the version pruner) deletes rows past the confirm window
  best-effort together with their Spaces objects. A per-user pending-row quota rejects
  new presigns beyond the cap. Confirm-failure paths best-effort delete the uploaded
  object; doc-only delete now also removes the object + thumbnail (the row held the
  only keys, so keeping the bytes was unrecoverable growth).
- **Sanitizer consolidation (item 2)**: one sanitizer in `assetLimits.sanitizeFilename`
  that also rejects `''`/`.`/`..` (falls back to `unnamed.bin`); `assetZip` reuses it.
- **Edit path (item 7)**: `writeAssetContent` gets optimistic concurrency — the asset
  row update is conditioned on the version it was read with, and a new `'conflict'`
  code surfaces to agent tools and the restore route (409). The old version is
  snapshotted before the Spaces PUT, and a failed post-PUT save best-effort restores
  the previous bytes. `findLineOccurrences` stops collapsing overlapping candidates so
  genuinely ambiguous matches are reported as ambiguous.
- **Memory bounds (items 6, 13, 14)**: thumbnail decodes enforce a megapixel cap
  before canvas allocation; `getObjectBuffer` accumulates with a running counter when
  `ContentLength` is absent; PDF rasterisation renders one page at a time via
  pdf-parse's `partial` page selection and hands each page to a callback instead of
  holding up to 50 PNGs.
- **Cleanup (items 15, 16)**: agent-side markdown is capped at `MAX_MARKDOWN_CHARS`;
  `ttlDays: 0` now means no-expiry on the reuse path too (parity with the write side).
  Small dead surfaces removed: duplicate 15 MB constant, double 1 MB cap, triple bulk
  size check (zod refine is the single enforcement), `previewAsset` derived from
  `safeAsset`, OCR fallback gets an owned predicate instead of error-string coupling,
  dead `markdownExtracted` index dropped, pruner boot timer cancelled on stop.

## Done

- [x] Ticket triaged; audit items mapped to decisions (this doc)
- [x] Worker: lease + heartbeat + attempts-bumping stale sweep + claim error logging + lifecycle error attribution (items 1, 10, 11, 12)
- [x] AssetJob TTL expiry on settle (item 9)
- [x] Sanitizer consolidation with `.`/`..`/empty rejection (item 2)
- [x] Presign: pending quota + `expiresAt` TTL + sweeper (items 3, 8)
- [x] Routes: ObjectId guards, bulk-download stream lifecycle, single bulk-size enforcement, `previewAsset` reuse (items 4, 5, 16)
- [x] Media: pixel cap, streaming byte counter, per-page PDF rasterisation (items 6, 13, 14)
- [x] Edit path: OCC conflict, pre-PUT snapshot, overlap ambiguity (item 7)
- [x] systemAssetService: markdown cap + ttlDays=0 parity (item 15)
- [x] Small dead surfaces (item 16)
- [x] `npm run ci` green

## Follow-ups

- Multi-instance asset workers remain coordination-light (single-instance deployment
  is the supported shape; the lease fences writes but does not elect a leader).
- The TTL backstop can orphan an uploaded object if the sweeper is down at expiry;
  acceptable for a 2h window.
