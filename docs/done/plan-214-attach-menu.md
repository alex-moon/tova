# Plan — #214: composer attach menu (Upload + recent files)

Branch: `feat/tv/214-attach-menu` (base: `epic/roster`, per `docs/plan-roster.md`)

## Motivation

Issue #214 (`Decide whether/how to reference an existing file for the next turn`)
asked whether and how the old "attach an existing library file" affordance
should return. It is now resolved by owner direction, stated 2026-10-08 in the
ticket thread:

> Can confirm this is needed after all for images to send them to a VLM. An
> agent that pulls an image in can't read it. So: I believe the correct way to
> do this is literally a little menu like you see in Teams - you hit the "attach"
> icon in chat, and instead of immediately opening the file dialogue, it opens a
> "drop-down" with "Upload" at the top, and then your five most recent files
> underneath it.

This is **approach C** (composer-side picker) from the ticket's candidate list.
The owner rejected the cross-route hand-off (B) in triage; a composer-local
menu keeps the reference ephemeral and colocated with the turn it applies to.
The earlier `plan-214-files-retrieval.md` (guard `files` vote + library-index
injection, approach D) already landed on `main` and is unchanged by this work —
the two are complementary: D improves automatic retrieval, C gives a deliberate
reference gesture for the cases D misses (and is the only way to hand an image
to the VLM, since an agent-pulled image is not re-sent as image bytes).

## Scope

- Client-only (`src/client`). The server asset list endpoint already returns the
  durable, non-ephemeral, owner-scoped library newest-first, so the "five most
  recent" come from the existing `GET /api/assets` (first page, first five rows).
  No new API is required.
- Not in scope: the read-file source chip / retrieval-legibility (approach D
  residual), multi-select, or persisting a reference across routes. One asset
  per message, matching the existing attachment model.

## Decisions

- **D1 — replace the attach button's direct file-picker with a menu.** Clicking
  the paperclip opens a small popover anchored above the composer: an "Upload"
  row at the top (which opens the native file dialogue exactly as before), then
  up to five most-recent files. This matches the owner's Teams-style direction.

- **D2 — the recent list is fetched lazily on open.** `AssetService.list()`
  (already exists) is called the first time the menu opens; the result is cached
  per menu session. No fetch on chat render, so a chat with no file interaction
  makes zero extra requests. A loading row shows while the fetch is in flight;
  an error keeps the Upload row usable and shows a short message.

- **D3 — picking a recent file reuses the existing attachment state.** It sets
  the same `attachment` shape (`{id, filename, contentType}`) as a fresh upload
  and fires the same `toastForAsset` no-text/pending toast. Selecting an item
  closes the menu. This is the same code path proven for library picks before
  #197 removed the old plumbing — no new send/contract.

- **D4 — one asset per message, pick replaces any current attachment.** Parity
  with the upload path (an upload also overwrites). No multi-select.

- **D5 — menu closes on outside click, `Escape`, or item pick.** Standard
  popover behaviour; keeps the composer usable on mobile where there is no hover.

- **D6 — client-only test coverage + Playwright at phone width.** Vitest covers
  open, lazy fetch, list rendering, pick, and close; the e2e/responsive suite is
  the mechanical backstop for overflow at 375px (mobile policy in `AGENTS.md`).

## Done

- [x] `ChatWindow.tsx`: attach paperclip opens a menu (`role="menu"`) with an
      "Upload a file" row + up to five recent files; closes on outside
      pointer-down, Escape, or pick; pick sets the attachment chip via the same
      shape as a fresh upload and reuses the shared `toastForAsset` toast.
- [x] Recent list via `AssetService.list()` on first open only (cached for the
      page lifetime), with loading / error / empty states; Upload is always
      available even when the fetch fails. No new server/API work — the existing
      owner-scoped, non-ephemeral `GET /api/assets` supplies the five most recent.
- [x] Client tests in `ChatWindow.features.test.tsx` (+7): lazy open, five-item
      cap + Upload-first, cache across open/close, pick → chip + close, fetch
      error keeps Upload, Escape/outside-close.
- [x] Verify: `npm run ci` green (87 server suites / 1073 tests; 18 client
      suites / 242 tests). Playwright render at 360px phone width: menu shows
      Upload + recent files, no horizontal overflow (`scrollWidth ==
      innerWidth`), pick produces the attachment chip. `test:e2e` responsive
      suite: 39/40 pass; the one failure (`/admin` users table rows not found)
      reproduces identically on the untouched base and is a fixture-state
      pre-existing issue, not caused by this change.

## Follow-ups

- Read-file source chip (#214 approach D residual) remains a separate trust
  improvement — `plan-214-files-retrieval.md` follow-up.
- "#214 and #166 resolved" roster checklist item: this closes #214's
  implementation; #166 still needs its mechanism proposal posted (blocked on
  owner), tracked separately in `docs/plan-roster.md`.
