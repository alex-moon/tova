# Plan: #51 — Attach an existing library asset to a chat message

Branch: `feat/51-asset-library`

## Motivation

#34 shipped the asset library (Sidebar → "Files" → `AssetLibrary`) and one-attachment-per-message
in the composer (ChatWindow), but they are disconnected: reaching a message requires re-uploading
bytes even for files already in the library. The library even advertises "attach it to a message
in the chat" with no mechanism to do so.

## Current state / file map

Server — **verified: no work expected.**

- `src/server/routes/chat.ts:34` (`loadAttachedAsset`) resolves `req.body.assetId` scoped to
  `_id + userId` (`Asset.findOne({ _id: assetIdRaw, userId: req.user?.id })`) and is applied to
  **both** POST message routes (`:215` and `:328`), returning `404 'Asset not found'` for another
  user's asset. The cross-user rejection is already tested in
  `src/server/routes/assets.attach.test.ts:143` ("rejects an attached asset owned by another user").
  Acceptance criterion 2 ("Attaching an asset from another user is impossible, api-level check
  verified by test") is therefore **already met**; no new server code or server test is needed, we
  only confirm the existing test still passes.
- One real server-side finding from verification: the asset **status enum is
  `['pending', 'ready', 'failed']`** (`src/server/models/Asset.ts:33`) and the list endpoint
  (`GET /api/assets`, `src/server/routes/assets.ts:180`) does **not** filter by status — the
  library shows `pending` and `failed` assets too. Only `ready` assets are attach-able in spirit
  (the download route rejects non-`ready` with 409). So the per-asset "attach" button **must
  disable for `status !== 'ready'`**; this is a real guard, not a no-op.

Client:

- Attachment state: `ChatWindow.tsx:270`
  `const [attachment, setAttachment] = useState<{ id: string; filename: string } | null>(null)`,
  sent at `:333` via `onSendMessage(input, attachment?.id, attachment?.filename)`, cleared after
  send (`:335`) and via per-chip Remove button (`:528`).
- Fresh-upload toast: `ChatWindow.tsx:347-351` in `handleAttachFile` — after a successful
  `AssetService.upload`, `setAttachment({ id, filename })` then
  `toast.info('No text could be extracted from this file type — Tova will see the filename only.')`
  when `asset.hasText` is false. The `attachment` state itself does **not** carry `hasText`
  (only id + filename), so the toast fires once at attach time — the picked-asset path must do
  the same (fire at pick time, don't try to re-fire from the chip later).
- `attachment` is **not** reset on session switch (the effect at `:284` is scroll-related only);
  it simply survives. The picked asset inherits this behavior — "keep both" is the rule.
- `AssetLibrary.tsx` is a self-contained modal taking only `{ onClose }`, rendered by
  `Sidebar.tsx:51` (`{showFiles && <AssetLibrary … />}`); `Sidebar` itself takes `open`,
  `onClose`, `showFiles` — `showFiles`/`setShowFiles` currently live **inside** Sidebar (`:51`
  closes it via `setShowFiles(false)`), so an external close from a pick needs a prop change
  (a controlled `showFiles` lifted to `App`, or an `onPick` callback that also requests close).
- `AssetSummary` (`src/client/src/services/assets.ts:12`, `status` field included) carries
  `id`, `filename`, `hasText`, `status` — everything the in-memory handoff needs; zero bytes.

## Decisions

- **Client-side handoff only.** No new endpoint, no state across the wire; message send already
  carries `assetId` through the validated path (verified above).
- **Threading direction:** pick happens in the library, so the handoff travels
  `AssetLibrary → Sidebar → App → ChatWindow`. `App.tsx` holds transient `pickedAsset`
  (`{ id, filename, hasText } | null`) plus an `onPickAsset` callback passed down; ChatWindow
  consumes it and converts to `attachment`.
- **Toast parity:** the picked asset flows through one shared assistant function that does
  `setAttachment` + the identical conditional `toast.info` — the toast logic is not duplicated.
  Because the existing `attachment` shape is `{ id, filename }` only, `hasText` lives in the
  transient pick, not in `attachment`.
- **Latest pick wins; picking while `uploading` or mid-send** behaves like the picker does today
  (a pick is not an interactive send; it just replaces the single attachment — can't have more
  than one attachment, deferred in #34/#48).
- **Attach closes the overlay(s):** picking sets `setShowFiles(false)` (via lifted/controlled
  state or an `onClose` along with the pick) and, on mobile, closes the sidebar drawer as well,
  matching "closes/jumps to chat". Simplest concrete shape: lift `showFiles` from `Sidebar` into
  `App` `showFiles`/`setShowFiles`; `App`'s `onPickAsset` records the asset **and** sets
  `showFiles(false)`. Sidebar's internal Files button then calls the lifted setter.
- **Status guard:** disable the attach button for `status !== 'ready'` (`pending` and `failed`
  both appear in the listing; only `ready` is send-able end-to-end). This resolves the old
  open question 2 by verification — no open question remains here.

- **Pick/upload race (resolved — concrete rule):** if a pick lands while `uploading === true` in
  ChatWindow, the in-flight upload's `setAttachment` would finish later and silently overwrite
  the pick. Rule: the consume effect **ignores the pick when `uploading` is true** (no
  `setAttachment`, no toast; the pick is still marked consumed). The user is mid-upload and will
  send the fresher file anyway; this makes behavior deterministic instead of last-writer-wins.
  Documented here as a decision, not an open question.
- **Composer picker placement (only relevant if the stretch item survives its bail-out rule):**
  decided now so no task depends on a question — "Browse library" sits **beside** the file-picker
  attach button in the composer row (one ghost Button, same size class as neighbors). If mounting
  it looks wrong there at implementation time, adjust visually; it never blocks items 1-3.

## Checklist (each item a safe single commit)

1. **[client] Thread the pick callback.**
   - `App.tsx`: add `pickedAsset` state (`{ id, filename, hasText } | null`); add
     `onPickAsset(asset: AssetSummary)` that stores it, sets `showFiles(false)`, and (mobile)
     leaves the sidebar drawer closed; lift `showFiles` from `Sidebar` if it isn't already there.
   - `Sidebar.tsx`: accept `showFiles`/`onToggleFiles` (or equivalent controlled props) from
     `App` and forward `onPickAsset` to `AssetLibrary`.
   - `AssetLibrary.tsx`: add one per-card "Attach to chat" button that calls
     `onPickAsset({ id, filename, hasText, status })` from the card's data; disable when
     `status !== 'ready'` (aria-disabled + disabled styling consistent with the file's buttons).
2. **[client] Consume the pick in ChatWindow.**
   - New prop `incomingAsset`; consumer effect: on a non-null pick, `setAttachment({ id, filename })`,
      fires the byte-identical `toast.info` when `hasText` is false, then resets the pick in `App`
      (via an `onPickConsumed` callback or a one-shot state clear in `App` after ChatWindow
      acknowledges) so re-picking the same asset later re-triggers the effect. Skip the
      `setAttachment` and toast when `uploading === true` (see Decisions race rule); still mark
      the pick consumed.
   - Confirm no regression: run ChatWindow tests (`picker flow` untouched; `setAttachment(null)`
     paths — send and Remove chip — still work with a pick-sourced attachment, which is the same
     state shape).
3. **[client tests]** (new file `src/client/src/components/AssetLibrary.test.tsx` — no test file
   for AssetLibrary exists yet; model it on `Sidebar.test.tsx`. ChatWindow additions go in the
   existing `ChatWindow.features.test.tsx`.)
   - `AssetLibrary.test.tsx`: clicking "Attach to chat" calls `onPickAsset` with the card's
     `id`/`filename`/`hasText`; button disabled for a `pending` and a `failed` asset
     (mock `AssetService.list` to return those statuses — the endpoint genuinely returns them).
   - ChatWindow test: picked asset with `hasText: false` produces the attachment chip +
     the same toast message as the fresh-upload path; with `hasText: true`, no toast.
   - (Server: nothing new; the existing `assets.attach.test.ts:143` cross-user test runs as part
     of `npm test` and covers acceptance criterion 2.)
4. **[stretch, do NOT let it block 1-3] Composer "pick from library" affordance.**
   - Concrete steps: add a small "Browse library" button next to the file-picker attach button
     in the ChatWindow composer; on click, if `AssetLibrary` (already a standalone modal taking
     only `onClose`) mounts and lists assets cleanly when rendered from ChatWindow (verify by
     importing it in a test render), wire it with `onPickAsset = (a) =>
     onPickedFromLibrary({ id, filename, hasText })` sharing the same consume logic as item 2;
     close the modal on pick / Cancel / X.
   - **Bail-out rule (from the ticket):** if this costs more than half the remaining ticket
     effort (e.g. mounting AssetLibrary standalone needs non-trivial refactor of Sidebar-owned
     styles/layout), stop, record "composer picker deferred" here, and open a follow-up ticket
     via the orchestrator. Items 1-3 satisfy the backlog acceptance criteria on their own.
5. **[verify]** `npm run lint`, `npm run typecheck`, `npm test`,
   `npm --prefix src/client run lint`, client vitest, then `npm run ci` as the final gate.

## Open questions

None blocking. Every doubt found during planning was resolved by verification (server
auth/scoping + existing cross-user test, asset status enum) or converted into an explicit
decision above (pick/upload race rule, composer picker placement). If the stretch item (list
item 4) survives its bail-out rule and AssetLibrary proves not to mount standalone without a
refactor, that becomes a new follow-up ticket rather than an open question here.

## Out of scope

- Multi-attach per message (explicitly deferred from #34/48).
- Image/preview thumbnails.
