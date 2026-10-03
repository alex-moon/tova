# Plan — #197 In-app asset viewer

Branch: `feat/197-asset-viewer`

## Motivation

Issue [#197](https://github.com/alex-moon/tova/issues/197): let a user open the
Markdown equivalent of any file — the file itself when it is Markdown, otherwise
the captured text for PDFs and friends — in the app as a rendered "preview".
This lets the user see what the agent sees and read generated docs.

The ticket left two scope/architecture questions open and invited a proposal
(as owner feedback in the triage thread):

1. Keep the Markdown preview inside the existing assets modal, or move the whole
   assets view out to a separate URL-backed view a la `/profile` and `/admin`?
2. Split image preview + OCR into new tickets (thumbnailing is not built yet),
   and if so which?

## Decisions

- **D1 — separate URL-backed view.** Assets move to `/assets`, mirroring the
  established `/profile` and `/admin` pattern (issue #95): a hand-rolled
  `isAssetsRoute()` check in `App.tsx`, a full-height `<AssetsView>`, and the
  shared `<BackToChatLink>`. A modal cannot give previews the real estate they
  need, and this is a reversible routing choice, not a data-model one. The
  existing `AssetLibrary` list UI becomes the master pane inside the view; the
  modal/overlay chrome is dropped for the view shell.

- **D2 — split image preview + OCR out.** Image preview depends on thumbnailing
  (not built) and OCR is its own ingest concern. Both are filed as new tickets
  and trimmed from #197, which keeps the Markdown/text preview core, as the
  ticket invites. #197's own suggestion ("any kind of support for these e.g.
  `(no extracted text)` would be great") is honoured by the viewer's empty
  state.

- **D3 — server read endpoint `GET /api/assets/:id/content`.** The extracted
  text is deliberately server-only today (`safeAsset` omits it; there is no
  single-asset read route). The viewer needs the body, so a new authenticated,
  ownership-scoped endpoint returns the preview payload. It returns
  `textExtracted ?? markdownExtracted` (matching the chat read path), the
  filename/contentType, and the conversion lifecycle fields. Registered
  **after** `/bulk-download` per the route-ordering note at `assets.ts:253`.
  Path is `/content`, not a bare `/:id`, to stay clear of `/:id/url` and future
  collisions.

- **D4 — reuse the chat Markdown renderer.** The preview must render exactly
  like assistant messages, so the `ReactMarkdown` +
  `remark-gfm`/`rehype-raw`/`rehype-sanitize` + `MarkdownLink` config currently
  inlined as `MessageContent` in `ChatWindow.tsx` is extracted into a shared
  `MarkdownContent` component and used by both. Stored markdown can contain raw
  HTML, so the raw+sanitize pair is preserved.

- **D5 — master/detail, no URL per asset.** The view shows the file list on the
  left and the selected file's rendered preview on the right, with selection as
  component state (like `AdminView`'s `activeSection`). This avoids needing an
  SPA route param and the server catch-all handling that would imply, and is
  enough real estate. Deferred: deep-linking a single asset.

- **D6 — empty/failed states.** When no text could be extracted, the preview
  shows `(no extracted text)` (the ticket's ask). While conversion is
  `pending`, it shows an extracting state; on `failed`, the failure reason.

## Done

- [x] Plan doc (this file).
- [x] Server: `previewAsset` view + `GET /api/assets/:id/content` route.
- [x] Server: route tests (auth, ownership 404, text vs markdown precedence,
      not-ready/pending, empty state).
- [x] Client: `AssetService.content(id)` + `AssetContent` type.
- [x] Client: extract shared `MarkdownContent` from `ChatWindow`.
- [x] Client: `isAssetsRoute()` + `<AssetsView>` at `/assets`.
- [x] Client: wire `<AssetsView>` into `App.tsx`; add a "View all files" link
      from the sidebar.
- [x] Client: `AssetsView` tests (list, select, render markdown, plain text,
      empty state, failed extraction, error).
- [x] Playwright visual check against a live local stack: four seeded assets
      (a `.md` upload, a converted `.pdf`, a plain `.txt`, a textless `.bin`)
      rendered correctly — markdown heading/bold/list, converted-markdown with
      an external link, plain text, and `(no extracted text)`. Fixed two issues
      found here: the embedded list needed a single-column layout (cards had
      collapsed to zero width), and a Markdown upload was mis-classified as
      plain text because its body lives in `textExtracted` (D3/D4 follow-up).
- [ ] Docs: update `tickets-261003.md` for #197 + record D1/D2.
- [x] `npm run ci` exits 0 (server 980 tests, client 215 tests).

## Follow-ups

- **Image preview** (thumbnail/preview in the viewer) — filed as a new ticket;
  depends on thumbnailing.
- **OCR ingest** — filed as a new ticket; separate ingest concern.
- **Deep-link a single asset** (`/assets/:id`) — deferred (D5).
