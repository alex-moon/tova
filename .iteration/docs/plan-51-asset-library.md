# Plan: #51 — Attach an existing library asset to a chat message

Branch: `feat/51-asset-library`

## Motivation

#34 shipped the asset library (Sidebar → "Files" → `AssetLibrary`) and one-attachment-per-message in the composer (ChatWindow), but they are disconnected: reaching a message requires re-uploading bytes even for files already in the library. The library even advertises "attach it to a message in the chat" with no mechanism to do so.

## Current state / file map

Server — **no work expected**:
- `src/server/routes/chat.ts:34` (`loadAttachedAsset`) already resolves `req.body.assetId` scoped to `_id + userId`, returning `'missing'` for another user's asset. Ownership/authorization check exists.
- Cross-user rejection is already tested: `src/server/routes/assets.attach.test.ts:143` ("rejects an attached asset owned by another user").

Client:
- Attachment state lives in `ChatWindow.tsx:270`: `const [attachment, setAttachment] = useState<{ id: string; filename: string } | null>(null)`; sent via `onSendMessage(input, attachment?.id, attachment?.filename)` at `:333`.
- Toast path on fresh upload, `ChatWindow.tsx:347-351`: fires `toast.info('No text could be extracted…')` when `asset.hasText` is false.
- `AssetLibrary.tsx` currently takes only `{ onClose }` and renders inside `Sidebar.tsx:51` (`{showFiles && <AssetLibrary … />}`).
- `AssetSummary` (`src/client/src/services/assets.ts:7`) carries `id`, `filename`, `hasText`, etc. — everything the in-memory handoff needs; zero bytes involved.

## Decisions so far

- **Client-side handoff only.** No new endpoint, no state pass across the wire; message send already carries `assetId` through the validated path.
- **Threading direction:** pick happens in the library (shallowest change), so the handoff must travel `AssetLibrary → Sidebar → App → ChatWindow`. `App.tsx` holds a transient "picked asset" (`{ id, filename, hasText } | null`) and passes an `onPick` callback down; `ChatWindow` consumes it and converts to `attachment`.
- **Toast parity:** the `hasText: false` toast must fire in the *same place and shape* as the fresh-upload path. Cleanest way: make the incoming `pickedAsset` flow through one assistant function (`handleAttachFile`-equivalent, i.e. `setAttachment` + conditional `toast.info`) rather than duplicating toast logic in App.
- Edge case: picking an asset (or a path through app state) then picking another before sending — latest pick wins; picked overlay closes on pick; picking while `uploading` or while a send is in flight behaves like the picker does today (no interactive send happens via pick, so).
- Attach also **closes the library overlay and (on mobile) the sidebar** so the user lands in the chat, matching the ticket's "closes/jumps to chat".

## Checklist (each item a safe single commit)

1. **[client] Thread the pick callback.** `App.tsx`: add `pickedAsset` state + `onPickAsset(asset: AssetSummary)` that records it and closes the library/sidebar-overlay. `Sidebar.tsx`: accept and forward an `onPickAsset` prop to `AssetLibrary`. `AssetLibrary.tsx`: add per-asset "Attach to chat" button (one per grid card; disable for `status !== 'ready'` assets, same listing already shows status via re-list endpoint? — verify at implementation time, see Open questions).
2. **[client] Consume the pick in ChatWindow.** New prop `incomingAsset` (or `onAttachPicked`); on arrival: `setAttachment({ id, filename })`, fire the identical `toast.info` when `hasText` is false, and clear the consumed pick (ref/state reset) so re-picking the same asset later re-triggers. Verify "no regressions to existing picker attach": run ChatWindow tests.
3. **[client tests]** `AssetLibrary.pay-load.test.tsx` (or extend a test file in `components/`): clicking "Attach to chat" (a) calls `onPickAsset` with the card's `id`/`filename`/`hasText`; **and** `App.test.tsx` (or `ChatWindow.feature.test.tsx`): a picked asset with `hasText: false` produces the attachment chip + the same toast as the fresh-upload path; with `hasText: true` no toast; existing picker flow untouched.
4. **[verify] `npm run lint`, `npm run typecheck`, `npm test`, `npm --prefix src/client run lint`, client tests, then `npm run ci` as the final gate.**

Deferred (spin into follow-up if needed): a "pick from library" button *in the composer itself* (modal reuse). The ticket explicitly allows shipping library→composer only if the composer picker more than doubles the work — the `App.tsx` threading above lands it for the Sidebar route; the composer affordance is a separate, smaller UI-only commit *only if* no open questions block it (see below).

## Open questions

- **Composer picker ("browse library" affordance):** undecided above — the clean composer-side modal needs a way to render `AssetLibrary` from within ChatWindow; the component currently couples to `Sidebar`'s layout (`onClose`), but it is already a self-contained modal, so it likely renders standalone. Pre-answer at implementation time by importing it in a Chat Window test — if it mounts and lists assets cleanly, wire the button; if not, defer per ticket guidance. Do not block checklist items 1-3 on this.
- **Disable-vs-include non-`ready` assets:** the listing endpoint filters (presumably) to ready/remove-failed states; confirm what statuses `list()` can actually return. If everything it returns is attach-able, item 1's guard is a no-op.
- **Clearing / stale state across sessions:** if the user picks an asset, never sends, then opens a different chat, should the picked attachment stay in the composer? Current picker behavior on session switch is the model to copy — verify how `attachment` interacts with session-effect on switch and keep either both cleared or both kept.
{}