# Plan — #252 Workspace provenance on generated files

> **Status: not done.** The merged PR #265 was a preliminary pass; this slice is still
> open. The Done checklist below records that pass only. Next phase: 2 — criticise and
> harden this plan, re-deriving the checklist against
> [#252](https://github.com/alex-moon/tova/issues/252), before implementing more.

## Motivation

Per GitHub issue [alex-moon/tova#252](https://github.com/alex-moon/tova/issues/252),
a slice of epic [#251](https://github.com/alex-moon/tova/issues/251).

The workspace (asset library) has no memory of where a file came from. `generate_file`
(issue #66) creates assets "indistinguishable from an upload" via `createSystemAsset`,
attributed only to the user. Uploads have no source record. Every later slice (task
artifacts, cross-chat memory, "which conversation produced this") depends on files
carrying provenance.

This slice is metadata + display only: no retrieval, no tasks, no new surfaces beyond
the provenance display. It lands first so the later slices have a vocabulary to write
into.

## Decisions

- **Field name `provenance`, separate from the scalar `origin`.** The Asset schema
  already has a #66-era scalar `origin: 'user-upload' | 'system-generated'` ("did Tova
  make it?"). That is a different, boolean-ish axis from "where did it come from", so
  the new block is an additive `provenance` subdocument and the scalar is left
  untouched. Reusing `origin` with a different shape would have collided with the
  existing enum.
- **Shape: `{ kind: 'upload' | 'chat' | 'task', sessionId?, taskId?, messageId? }`.**
  `kind` is the only required field. This is the vocabulary slices 3 and 4 write later
  (task artifacts → `kind: 'task'` + `taskId`; cross-chat memory → `kind: 'chat'` +
  `sessionId`/`messageId`).
- **Absence policy: absent means "unknown", never faked.** No `default` on the
  subdocument, and no read-time `{}` — a default would serialise a non-null
  "unknown-but-present" value and break the invariant (same rule as roster pricing,
  #199: missing ≠ free). Legacy rows simply have `provenance: undefined`.
- **`_id: false` on the subdocument.** Provenance is a singleton value object; a
  per-row subdoc id is pure noise.
- **Views serialise absent provenance as explicit `null`.** `safeAsset` and
  `previewAsset` (`assetViews.ts`) emit `provenance: (doc.provenance) ?? null` so the
  client sees a stable key and can distinguish "unknown" from "field missing in an old
  payload". This `null` is a wire-serialisation choice, not a persisted default.
- **`generate_file` stamps `{ kind: 'chat', sessionId }`.** The session id rides to
  tool execution on Mastra's `RequestContext` via a new `CompletionOptions.sessionId`
  that is distinct from `trace.sessionId`: `trace` is a LangSmith concern and is
  deliberately absent for ZDR/raced turns, whereas a provenance-writing tool needs the
  session independently of tracing. When no session is on the context (ZDR, raced
  calls, future non-chat callers) the file is left with absent provenance rather than
  inventing one.
- **Uploads stamp `{ kind: 'upload' }`.** Every presign records the upload kind.
  Chat-composer uploads deliberately get the same: presign runs before the session may
  exist (#144), so there is no truthful session id to record — inventing one would
  break the absence policy.
- **`createSystemAsset` gains a trailing optional `provenance?` argument.** Omitted
  means "leave absent"; every existing call site keeps compiling. No default is applied.
- **Display.** `AssetLibrary` shows a short label ("Uploaded" / "From chat" / "From
  task") appended to the size/date line; unknown renders nothing. Mobile-first per the
  standing client rules — the label is inline text, no new layout surface.

## Done

- [x] Ticket + branch `feat/252-workspace-provenance`
- [x] `Asset.provenance` subdocument + exported `AssetProvenance` type
- [x] `CompletionOptions.sessionId` threaded into the Mastra `RequestContext`
- [x] `generate_file` stamps `{ kind: 'chat', sessionId }` from its request context
- [x] `createSystemAsset` accepts an optional `provenance` argument
- [x] `assetPresign` stamps `{ kind: 'upload' }`
- [x] `assetViews` (`safeAsset`, `previewAsset`) surface provenance (null when unknown)
- [x] `AssetLibrary` provenance label, mobile-first
- [x] Tests: model, `assetViews`, `systemAssetService`, `assetTools`, `AssetLibrary`
- [x] `npm run ci` green
- [x] PR opened (#265)

## Notes

- **Admin asset view.** The ticket lists "the admin asset view" among the surfaces to
  update, but no admin asset view or admin asset-list endpoint exists in this repo (the
  admin surface is evals, LangSmith, PATs). The scope guard forbids new surfaces beyond
  the provenance display, so this slice does not build one. The server-side views
  (`assetViews.ts`) are the shared serialisation point any future admin surface would
  consume, so provenance is already available to it.

## Follow-ups

- Slices #253/#254 (task artifacts, cross-chat memory) write `kind: 'task'` /
  `messageId` into this vocabulary.
- If an admin asset view is added later, it should read provenance from the existing
  `assetViews` serialisation rather than re-deriving it.

## Process log

- Owner correction (2026-10-10): PR #265 was preliminary; the slice is **not done**. The
  Done checklist above records the preliminary pass only — phase 2 must re-derive the
  remaining work against the ticket before implementing further.
