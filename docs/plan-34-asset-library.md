# Plan: Asset library — user file uploads to DigitalOcean Spaces via presigned URLs

Issue: https://github.com/alex-moon/tova/issues/34
Branch: `feat/tv/34-asset-library`

## Motivation

Users cannot give Tova files today: there is no upload handling and no object
storage integration in the codebase (verified: no multipart parser, no storage
service in `src/server/services/`). An asset library unblocks
"Tova can see the file" experiences — attach to chat, reference in prompts —
that in-flight work (profiles, MCP) can build on.

## Decisions so far (from issue #34 and its comments)

- **Presigned URLs, not proxy uploads.** Browser PUTs directly to Spaces;
  our server only mints short-lived URLs and confirms afterwards. No file
  bytes through Express.
- **Credentials are unblocked.** `DO_SPACES_KEY`, `DO_SPACES_SECRET`,
  `DO_SPACES_BUCKET` are present in local `.env` (owner provided the secret
  key in issue comments after an initial block). `.env` uses the `DO_SPACES_`
  prefix — we will document/standardize on these names in `.env.example`
  (the issue text suggested `SPACES_*`; the actual env wins), reading with a
  fallback so either prefix works if desired.
- **Private objects only.** No `public-read` ACL; downloads go through
  short-expiry presigned GETs.
- **Key layout:** `<userId>/<assetId>/<filename>` for unambiguous ownership
  and trivially scoped listing.
- **Extraction stays minimal.** Deterministic, fast text extraction only
  (txt/md/csv/pdf). No RAG/embeddings/VLM work on this ticket. Owner OK'd
  deferring even the processing-worker idea to a follow-up ticket.
- **Owner's explicit constraint:** never render user file content in the
  browser — the library grid shows type **icons only**, not thumbnails/previews.
- **"Attach to message" phase:** a single file can be attached to a single
  message as a reference (FK to Asset), with its extracted text included
  in the prompt.

## Honest boundaries (what "done" means here)

- End-to-end proof against the real Space is achievable locally since
  credentials exist, but the final `tova` bucket state is shared with live
  usage (issue says the key also works there) — tests will use a
  test-prefixed key layout, never bulk-delete shared bucket contents.

## Checklist (each item ≈ one commit)

- [ ] **Deps + config.** Add `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
      New `src/server/services/storageService.ts`: lazy singleton S3 client
      (endpoint from region, v4 signature, Spaces host style). Feature gated
      off when env vars absent — same pattern as `webSearchService` and
      `BRAVE_API_KEY`. Document env vars in `.env.example`.
- [ ] **Asset model.** `src/server/models/Asset.ts`: userId, filename, key,
      contentType, size, status (`pending|ready|failed`), timestamps.
- [ ] **Upload API.** `POST /api/assets/presign` (auth'd, zod-validated:
      filename, contentType, size) → mime allowlist + 15 MB max → mint
      60s-expiry presigned PUT → return `{ uploadUrl, asset }`.
      `POST /api/assets/:id/confirm` → server HEADs the object, verifies
      existence and real size, flips status to `ready` (or `failed`),
      reconciles stored contentType/size with HEAD results.
- [ ] **List/read/delete API.** `GET /api/assets` (cursor-paged, strict
      `userId` scoping), `GET /api/assets/:id/url` (short-expiry presigned
      GET), `DELETE /api/assets/:id` (delete object from Spaces, then doc).
      Ownership enforced on every route.
- [ ] **Server tests.** Ownership isolation (user A cannot list/GET/delete
      user B's assets), presign rejects oversized/disallowed types, confirm
      rejects when HEAD fails or size mismatches. Unit-test with mocked
      S3 client; no live Space dependency in CI-safe tests.
- [ ] **Client: asset library panel.** Minimal route/section in the client
      (`src/client/src`): drag-drop upload with progress (XHR directly to
      Spaces), grid of per-asset cards showing **type icon only** (per
      owner constraint), filename, size, created date, delete button.
- [ ] **Client wiring + e2e-ish verification.** Hook the panel into the
      app shell, verify upload → confirm → list → download → delete against
      the real Space locally. `npm run ci` green.
- [ ] **Attach to message.** Data change: `messages.assetIds` (or a link
      collection) — single asset per message for now. Composer gets a small
      "attach file" affordance that presigns+uploads, shows the attached
      filename as a chip (icon, not a preview), and stores the FK. Send
      message includes a delimited block with the asset's extracted text.
- [ ] **Light text extraction.** Deterministic, dependency-light module:
      `txt`/`md`/`csv` read as UTF-8; `pdf` via a thin extraction of the
      text layer; everything else returns "no text extracted" marker.
      Truncation cap applied before prompt inclusion. Extracted text stored
      on the Asset doc at confirm time (single write, no worker).
      *(If the PDF half of this grows past ~one small dependency-free helper,
      defer PDF extraction to a follow-up ticket — see open questions.)*

## Open questions

1. **PDF extraction dependency.** A real `pdf-parse`-style dependency may be
   worth it even in a "light" pass; decide at implementation time based on
   package weight and how well it works in our Jest environment. Deferring
   PDF (shipping txt/mv/csv first) is acceptable per the owner's "minimal
   for now" guidance.
2. **Extraction at confirm vs. on first message attach.** Plan prefers
   confirm-time (simpler, no async worker); if extraction occasionally
   triggers slow confirms for large files, re-dispatch to the deferred
   worker-service follow-up ticket.
3. **Env var naming.** `.env` has `DO_SPACES_*`; issue text said `SPACES_*`.
   Plan reads the `DO_SPACES_*` names (as they exist locally). A CI/live
   deploy must set both-case-equivalent values; confirmation from the user
   that live `.env` has been updated with the same names landed in issue
   comments ("check .env on local and on live") — treat as done, verify at
   deploy time on the #32/#8 deploy path.
4. **Cursor paging format.** Reuse whichever cursor-paging pattern is used
   by the existing chat-session listing (read at implementation time); if
   sessions don't paginate yet, use a simple `_id`-based cursor.
