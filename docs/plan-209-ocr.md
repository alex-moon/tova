# Plan — #209 Asset ingest: OCR for images (and scanned PDFs)

Branch: `feat/tv/209-asset-ingest`

## Motivation

Issue [#209](https://github.com/alex-moon/tova/issues/209), split out of #197.
The asset worker already extracted text deterministically (txt/md/csv) and
converted pdf/docx/html to Markdown, but images and scanned PDFs yielded no
text: the viewer showed `(no extracted text)` and the agent's `read_file`
returned `hasText:false`. Scanned PDFs were worse than empty — `pdf-parse`
returned no text yet the worker still marked `markdownStatus='ready'`, a
success-looking empty.

This ticket adds OCR as an ingest concern so image uploads and image-only PDFs
populate the existing `markdownExtracted`/`markdownStatus` fields and the agent
and viewer both work with no new read path. Related-but-distinct: #115 (VLM
image understanding, closed) and #208 (image preview / thumbnails).

## Decisions

- **D1 — engine: `tesseract.js` (self-hosted, owner decision).** Pure
  JS/WASM, no native binary and no new service or sidecar; it runs in-process
  on the existing worker, consistent with the repo's "no ad-hoc external glue"
  ethos. Rejected a hosted API (Google Vision / AWS Textract): faster/better
  but a provider commitment the repo has avoided. English-only ("eng"),
  minimal, per the owner. Traineddata is vendored at
  `assets/tessdata/eng.traineddata.gz` so the live worker needs no CDN egress;
  the `Dockerfile` copies `assets/` into the runtime image, and tesseract.js's
  decompression cache is redirected to `os.tmpdir()`.

- **D2 — PDF rasterisation: `pdf-parse`'s `getScreenshot()`.** The owner
  suggested `pdf-to-img`. That package is ESM-only, and this server is a
  CommonJS build (`tsc`/`ts-jest` would downlevel `import()` into a broken
  `require()`). `pdf-parse` — already the first-party PDF text dependency —
  exposes `getScreenshot()`, backed by its bundled pdf.js + `@napi-rs/canvas`,
  so no new runtime dependency is introduced. 2× render scale. (If a future
  ESM migration lands, `pdf-to-img` becomes viable; not worth it here.)

- **D3 — job model: fold OCR into the existing `conversion` lifecycle, no new
  job type.** Images previously carried only a thumbnail job. Instead of a
  third queue, images now set `markdownStatus='pending'` at confirm and
  `processConversion` branches on image content type *before* the
  `isConvertible` guard. One `AssetJob` covers markdown + thumbnail for an
  image; the processor runs each pending lifecycle independently so an OCR
  failure does not deny the thumbnail its result.

- **D4 — output feeds `markdownExtracted`, not a dedicated field.** The ticket
  left this open. Reusing the markdown path means `units`, `libraryBlockFor`
  and the viewer "just work" with no new read path; provenance can be
  distinguished later if there is a reason. OCR text is normalised through the
  shared `finalizeMarkdown` (cap + cleanup) as untrusted, attacker-influenceable
  input.

- **D5 — scanned vs born-digital gate.** A PDF is treated as scanned only when
  the `pdf-parse` text layer is near-empty (`< OCR_PDF_EMPTY_CHARS`, 16 chars)
  or conversion threw `empty markdown`; born-digital PDFs keep their text and
  never pay the OCR cost. Per-page OCR text is assembled with the same
  `-- n of n --` separators pdf-parse emits so `extractUnits` splits the result
  into page units.

- **D6 — operator guardrails for the tiny instance.** A per-attempt timeout
  (`OCR_TIMEOUT_MS`, 120s), an input-size ceiling (`OCR_MAX_INPUT_BYTES`, 8 MB)
  above which OCR is skipped entirely with reason `too large for OCR`, and a
  page cap (`OCR_MAX_PDF_PAGES`, 50). A blank/unreadable raster fails with
  `no text found by OCR` rather than storing a success-looking empty.

## Done

- [x] Plan doc (this file).
- [x] Server: `ocr.ts` (constants, `isNearEmpty`, `finalizeOcrText`,
      `recognizeImage` over tesseract.js with per-call worker create/terminate).
- [x] Server: `pdfRasterize.ts` via `pdf-parse` `getScreenshot()`.
- [x] Server: `finalizeMarkdown` extracted from `markdownConversion` and shared
      with the OCR store path.
- [x] Server: `assetJobProcessor` image + scanned-PDF branches; blank -> failed
      with a reason; size/page caps; independent thumbnail lifecycle.
- [x] Server: `assetConfirm` enqueues the OCR (markdown) lifecycle for images.
- [x] Server: vendored `assets/tessdata/eng.traineddata.gz`; `Dockerfile`
      copies `assets/`; `tesseract.js` dependency.
- [x] Tests: `ocr.test.ts` (real engine: constants, `isNearEmpty`,
      `finalizeOcrText`, `rasterizePdf`, `recognizeImage` incl. scanned PDF);
      `assetJobProcessor.ocr.test.ts` (mocked engine: image OCR, thumbnail
      independence, blank -> failed, size cap, scanned PDF page units,
      born-digital PDFs never OCRed); `assets.test.ts` enqueue expectations.
- [x] `npm run ci` exits 0.

## Follow-ups

- **Multi-language traineddata** — deliberately `eng`-only this pass (owner:
  minimal). A language-setting surface is its own ticket.
- **Scanned-PDF partial OCR** — a PDF with a thin (non-empty but incomplete)
  text layer is currently trusted rather than OCRed page-by-page; a
  per-page fallback would be its own ticket.
- **Client copy for oversized inputs** — the failure reason surfaces through
  `markdownFailureReason`, but the front-end does not yet special-case a
  too-large-for-OCR message. Optional UX nicety.
