# Plan — #208 Asset viewer: image preview (after thumbnailing)

Branch: `feat/tv/208-image-preview`

## Motivation

Issue [#208](https://github.com/alex-moon/tova/issues/208), split out of #197:
the `/assets` viewer renders the Markdown/text equivalent of a file, but image
files only ever show an icon. This ticket adds an image preview to the detail
pane. The ticket makes the pipeline a prerequisite: large originals must not be
loaded straight into the viewer, so the thumbnail is generated on the asset
worker and stored alongside the original, then served to the pane. OCR is a
separate ticket (#209); VLM understanding is the closed #115.

## Decisions

- **D1 — thumbnail engine: `@napi-rs/canvas`.** It is already in the dependency
  tree (transitively, via `pdf-parse`) and is a native Skia binding that can
  decode + resize the four allowlisted image types (png/jpeg/webp/gif). Promote
  it to a **direct dependency** so the image path does not depend on
  `pdf-parse`'s internals. Rejected `sharp` (a second native toolchain not
  otherwise needed) and `jimp` (pure-JS, slower, another dep).

- **D2 — generate on the existing worker, not a new queue.** The ticket says
  "generate on the asset worker". #67 already built a Mongo-backed job queue
  (`AssetJob`) with an in-process poller. Extending that processor to also do
  thumbnails (rather than standing up a second queue) is the minimal mechanism:
  same claim/attempt/requeue/failure semantics for free.

- **D3 — thumbnail lifecycle mirrors markdown lifecycle.** Add
  `thumbnailStatus` (`none|pending|ready|failed`) to `Asset`, and a
  `thumbnailKey` string. The key is derived alongside the original
  (`<userId>/<assetId>/thumbnail`), set when the job stores the object. Enqueue
  at confirm when the confirmed object is an image. Failure never fails the
  asset — the binary is fine and the viewer falls back to the icon.

- **D4 — serve via a presigned GET dedicated to the thumbnail.** The ticket
  notes `/:id/url` "can serve the bytes once a size-appropriate object exists".
  Rather than overload `/:id/url` (which presigns the original and is scoped to
  `status==='ready'`), add `GET /:id/thumbnail-url`: ownership-scoped, requires
  `thumbnailStatus==='ready'` and a `thumbnailKey`, returns a short-lived
  presigned GET for that key. This keeps the original-download contract
  untouched and gives the client an explicit "not ready yet" signal via 404/409.

- **D5 — client renders the thumbnail for image assets.** In `AssetsView`, when
  the selected asset's `contentType` starts with `image/`, the detail pane
  fetches the thumbnail URL and renders `<img>`. While `thumbnailStatus` is
  `pending`, show the extracting state; on `failed`/`none`, fall back to the
  existing `(no extracted text)` copy. Non-image assets are unchanged.

## Done

- [x] Plan doc (this file).
- [x] Server: `@napi-rs/canvas` direct dep; `imageThumbnail` (decode + resize
      + white mat + PNG encode, bounded to 512px long edge).
- [x] Server: `Asset.thumbnailStatus` / `Asset.thumbnailKey`.
- [x] Server: confirm enqueues a thumbnail job for images (shared with the
      conversion job when both are pending).
- [x] Server: `assetJobProcessor` dispatches conversion and/or thumbnail;
      `assetJobService` terminal-failure fails whichever lifecycle is pending
      without clobbering the other.
- [x] Server: `thumbnailStatus` in `safeAsset`/`previewAsset`;
      `GET /:id/thumbnail-url` returns `{ url, status }` (null url until ready).
- [x] Server: tests (helper, processor e2e, confirm enqueue + failure revert,
      route ready/pending/failed/auth/ownership).
- [x] Client: `AssetService.thumbnailUrl(id)`; `AssetsView` image branch with a
      pending poll so the preview appears in place; `AssetLibrary` polls while
      any thumbnail is pending.
- [x] Client: `AssetsView` tests for ready/pending/none image states.
- [x] `npm run ci` exits 0 (server 994 tests, client 218 tests).
- [x] Playwright check against a live local stack: uploaded an 800×500 PNG,
      confirmed the worker derived the 512px thumbnail (`thumbnailStatus`
      `ready`, object stored alongside the original) and the detail pane
      rendered it. Test asset and its objects removed afterwards.

## Follow-ups

- **OCR ingest** — #209, separate ticket; needs an engine decision (see
  `plan-209-ocr.md` if opened).
- **PDF page preview** — #208 is images only; a PDF first-page raster preview
  would be its own ticket.
- **Thumbnail backfill** — assets uploaded before this change have no
  thumbnail; the viewer falls back to "(no preview available)". No backfill
  job in scope.
- **Grid thumbnails** — the library grid still shows icons; only the detail
  pane renders the thumbnail (the ticket's ask).
