# Plan: Asset library — user file uploads to DigitalOcean Spaces via presigned URLs

Issue: https://github.com/alex-moon/tova/issues/34
Branch: `feat/tv/34-asset-library`

## Motivation

Users cannot give Tova files today: there is no upload handling and no object
storage integration in the codebase (verified: no multipart parser, no storage
service in `src/server/services/`, no Asset-related code outside this plan).
An asset library unblocks "Tova can see the file" experiences — attach to
chat, reference in prompts — that in-flight work (profiles, MCP) can build on.

## Decisions so far (from issue #34 and its comments)

- **Presigned URLs, not proxy uploads.** Browser PUTs directly to Spaces;
  our server only mints short-lived URLs and confirms afterwards. No file
  bytes through Express.
- **Credentials are unblocked (resolved in issue comments).** `DO_SPACES_KEY`
  was found in `.env`; the secret key was initially missing (posted as a
  blocker comment) and the owner then added `DO_SPACES_SECRET` (and
  `DO_SPACES_BUCKET`) locally and on live — verified present in local `.env`
  now. `.env` uses the `DO_SPACES_` prefix; the issue text's `SPACES_*`
  naming is superseded — we standardize on `DO_SPACES_*` in `.env.example`
  (no fallback aliasing; the one real name only).
- **Bucket & permissions.** The key/secret pair has read/write/delete on a
  bucket named `tova` but **not** bucket-policy permission (owner's comment).
  We must not create buckets or change ACLs/policies with this key. Assume
  the bucket already exists on live; if a locally-minted presigned PUT fails
  with `NoSuchBucket`, that is a blocker → post to #34.
- **Private objects only.** No `public-read` ACL; downloads go through
  short-expiry presigned GETs.
- **Key layout:** `<userId>/<assetId>/<filename>` for unambiguous ownership
  and trivially scoped listing. Test data uses a `test-` filename prefix;
  never bulk-delete shared bucket contents (live shares this bucket).
- **Extraction stays minimal (resolved in issue comments).** Owner: "light"
  means deterministic and fast; doing extraction well leads down the RAG path
  (VLM, embeddings, BM25) — explicitly out of scope. Owner explicitly OK'd
  deferring a processing worker to a follow-up ticket. Scope on this ticket:
  `txt`/`md`/`csv` as UTF-8. See open questions for the PDF decision.
- **Owner's explicit constraint (comment):** never render user file content
  in the browser — the library grid shows type **icons only**, not
  thumbnails/previews.
- **"Attach to message" phase (comment):** a single file can be attached to
  a single message as a reference (FK to Asset), with its extracted text
  included in the prompt.

## Honest boundaries (what "done" means here)

- End-to-end proof against the real Space is achievable locally since
  credentials exist, but the `tova` bucket is shared with live usage — tests
  will use a test-prefixed key layout and clean up only their own objects.
- **Assumption being criticized:** the plan leaned on `@aws-sdk/client-s3`
  being the obvious choice. It is (AWS SDK v3 works with Spaces endpoints),
  but packages should be installed and their practices kept lazy-loaded so
  cold-start/CPU cost stays bounded. No alternative SDK is being considered.
- **Assumption being criticized:** "presign → browser PUT → confirm HEAD"
  has a known gap: uploads can succeed between HEAD-check timing windows, so
  `pending` assets that were never confirmed linger as orphans. Accepted for
  this ticket; a cleanup sweep is deferred with the worker follow-up.
- **Assumption being criticized:** messages currently assume text-only
  content; attaching an asset changes the send-path prompt assembly. The
  attach feature touches the hot send path — keep the change additive
  (a delimited block in the prompt only when an asset is attached) so
  text-only behavior is bit-for-bit unchanged and covered by existing tests.

## Checklist (each item ≈ one commit)

- [x] **Deps + config.** Add `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
      New `src/server/services/storageService.ts`: lazy singleton S3 client
      (endpoint `https://<region>.digitaloceanspaces.com`, v4 signature,
      virtual-hosted-style bucket host). Feature-gated off when env vars
      absent — same pattern as `webSearchService` / `BRAVE_API_KEY` (read
      that file first and mirror its env check + export style). Document
      `DO_SPACES_KEY` / `DO_SPACES_SECRET` / `DO_SPACES_BUCKET` / region in
      `.env.example`.
- [x] **Asset model.** `src/server/models/Asset.ts` modeled on existing
      `Session`/`Message` model files: userId, filename, key, contentType,
      size, textExtracted (nullable string), status
      (`pending|ready|failed`), timestamps. Index on `{ userId, _id }` for
      cursor-paged listing.
- [x] **Upload API.** `POST /api/assets/presign` (auth'd, zod-validated:
      filename, contentType, size) → allowlist mime types, 15 MB max →
      create asset doc with status `pending` → mint 60s-expiry presigned PUT
      for key `<userId>/<assetId>/<filename>` → return `{ uploadUrl, asset }`.
      `POST /api/assets/:id/confirm` (auth'd, owner-checked) → server HEADs
      the object, verifies it exists and size ≤ 15 MB, stores extracted text
      if applicable, flips status to `ready` (or `failed` with reason),
      reconciles stored contentType/size from HEAD results. Reject confirm
      on assets older than ~1 h (presign + headroom) to avoid reviving stale
      pending rows.
- [x] **List/read/delete API.** `GET /api/assets` (cursor-paged, strict
      `userId` scoping — reuse the paging pattern from chat-session listing;
      if sessions don't paginate, simple `_id`-based cursor), `GET
      /api/assets/:id/url` (presigned GET, ~5 min expiry), `DELETE
      /api/assets/:id` (delete object from Spaces first, then doc; treat
      `NoSuchKey` as success so deletes converge). Ownership enforced on
      every route (`requireAuth` + explicit `userId` match, matching
      existing route conventions).
- [x] **Server tests.** Ownership isolation (user A cannot list/GET/delete
      user B's assets), presign rejects oversized/disallowed types, confirm
      rejects when HEAD fails or size mismatches, delete tolerates missing
      objects, extraction unit tests incl. truncation cap. All with a mocked
      S3 client — no live Space dependency in CI tests.
- [x] **Client: asset library panel.** Route/section in `src/client/src`
      mirroring how existing client routes are declared. Drag-drop + file
      picker upload, XHR directly to Spaces with progress; grid of
      per-asset cards with type icon only (owner constraint), filename,
      size, created date, delete with confirmation. No `objectURL`/img
      rendering of asset content anywhere.
- [x] **Client wiring + e2e-ish verification.** Hook panel into app shell;
      verify upload → confirm → list → download → delete against the real
      Space locally using `test-`-prefixed keys (script or hand-run per
      dev-server workflow). `npm run ci` green.
- [x] **Attach to message.** Schema change: single `assetId` FK on the
      message (owner asked for single-file reference; keep a column not an
      array until multi-attach is asked for). Composer gets an "attach file"
      affordance (presign + upload + auto-confirm), attached filename shown
      as a chip with icon (no preview). Send path: when the outgoing message
      carries an assetId and the asset is `ready`, include a clearly
      delimited block with the extracted text (truncated) in the prompt; no
      asset → prompt identical to today. Add tests for both branches.
- [x] **Light text extraction.** Deterministic, dependency-free module:
      deterministic UTF-8 decode for `txt`/`md`/`csv`; everything else
      returns null ("no text extracted"). Truncation cap applied before
      prompt inclusion. Extract even if the extension is uppercase/differed
      by mime sniff from the client-provided type; treat type mismatch as
      "no text". Runs synchronously inside `/confirm` (single write, no
      worker — worker idea explicitly deferred by owner to follow-up).

## Resolved questions

1. **PDF extraction — out of scope for this ticket.** Owner confirmed:
   text-only formats (`txt`/`md`/`csv`) for now, everything else gets a
   "no text extracted" marker — and, per the owner's later comment, user
   feedback for it. Shipped: confirm responses carry `hasText`, and the
   composer attach flow toasts "No text could be extracted from this file
   type — Tova will see the filename only." PDF (and any worker story) goes
   to a scoped follow-up ticket.
2. **Live `.env`/deploy parity.** Owner said find the vars on local and on
   live, but deploy path (#32/#8) is outside this ticket's reach; treat the
   live side as expected-done and verify at deploy time — a deploy-time
   check, not a code task. NOTE: local `.env` was missing
   `DO_SPACES_REGION`; it is now set to `lon1` locally and documented in
   `.env.example`. Live needs the same var before the feature works there.
3. **Actual Spaces region — resolved `lon1`.** Confirmed empirically with
   a ListObjectsV2 call against the real bucket (region sweep over every
   DO Spaces region). Endpoint hardcodes `lon1` as fallback; env override
   (`DO_SPACES_REGION`) kept decisive for other hosts.
