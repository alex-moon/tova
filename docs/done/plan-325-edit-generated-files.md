# Plan — #325 Assistant can edit assistant-generated files in its workspace

Ticket: [alex-moon/tova#325](https://github.com/alex-moon/tova/issues/325).

## Motivation

The agent has exactly one write path into the workspace: `generate_file`
(`apps/server/src/services/mastraService.ts`), which always creates a **new**
markdown asset through `createSystemAsset`. When the user says "update the notes
from yesterday" or "fix the second section of that draft", the assistant either
regenerates the whole document under a new name (library clutter, two sources of
truth) or declines. This slice gives the assistant a second write path: a
non-destructive edit of a file it generated earlier, in the same conversation or
a past one.

## Decisions

- **Representation: search/replace blocks** (`edit_file` takes an id plus one or
  more `{ oldText, newText }` edits). Chosen over whole-content rewrite (banned
  by the acceptance: cost must be proportional to the edit, not the file) and
  over unified diffs (model-generated diffs routinely fail to apply, and the
  retry story is fuzzy). Search/replace anchors the model to exact existing
  text and yields clean typed failures (`no_match`, `ambiguous`) it can retry
  after a `read_file`. Owner decision, 2026-10-15.
- **Versioning: history + restore** (owner decision, 2026-10-15). Every content
  write snapshots both the pre-write version and the new version into a new
  `AssetVersion` collection, so history is complete and append-only; the `Asset`
  row always mirrors the latest. Restore writes the chosen version's text as a
  **new** version (nothing is overwritten), so a restore is itself undoable.
- **Scope: assistant-generated files only** (`origin: 'system-generated'`).
  Uploads are not editable in v1 — the ticket's suggested default. This is also
  the only set `createSystemAsset` produces, so the editable set is well-defined.
- **Provenance is preserved, not restamped.** The ticket requires provenance to
  still name the originating chat/task, so an edit does not touch
  `Asset.provenance`. (An edit from a different conversation leaves the file
  attributed to where it was created.)
- **Unique match required, behind a tolerance ladder.** An `oldText` that is
  absent fails `no_match`; one that matches more than once fails `ambiguous`
  (the model adds surrounding context). Replacing the first of several matches
  silently is rejected — editing the wrong occurrence is worse than a retry.
  The matcher is ported from opencode's edit tool (MIT): when there is no exact
  match it retries while ignoring typographic quote/dash/space variants, then
  trailing whitespace per line, and it matches against the LF view so CRLF
  endings neither block matches nor leak into untouched regions. Owner decision,
  2026-10-15 (after reviewing how opencode does file editing).
- **Edits apply sequentially** against the running content, so a call can make
  several changes and a later edit sees an earlier edit's output.
- **The tool result carries a unified diff** (`diff` npm package, as opencode
  does) of the before→after content, so the change is auditable in the
  conversation. Rendering it in the client is a follow-up; the model-facing
  cost stays proportional to the edit.
- **An edit that replaces text with itself fails `no_change`** rather than
  writing a version identical to the last (which would otherwise loop the model
  through identical retries).
- **`Asset.version` (default 1) is the current version number.** Version rows are
  created lazily on the first edit — a never-edited generated file has
  `version: 1` and no `AssetVersion` rows, so `generate_file`'s hot path is
  untouched and unedited files cost no extra storage. History is therefore
  `version > 1`; the client shows the affordance only then.
- **Empty or oversized result is rejected** (`invalid`), matching
  `createSystemAsset`'s empty/`too_large` rules, and the new bytes are checked
  against `MAX_ASSET_SIZE` before anything is written.
- **Downstream effects mirror a fresh generate.** The Spaces object at the
  unchanged key is overwritten, `textExtracted`/`size` are updated, and
  `enqueueWorkspaceEmbedding` re-runs (the `textHash` change re-embeds). No
  asset job is enqueued — system assets never had one.
- **Client surface lives in the existing Files view.** `AssetsView` gains a
  History toggle (shown when `version > 1`) listing versions; a version can be
  previewed read-only and restored. Mobile-first, inline, no new route.

## Done

- [x] Branch `feat/tv/325-edit-generated-files`, plan doc
- [x] `AssetVersion` model + `Asset.version` field
- [x] `assetEditService`: `applyEdits` (search/replace) and `restoreVersion`,
      shared content-write core (version snapshots, Spaces, embedding)
- [x] `edit_file` tool: definition, registration, prompt instruction
- [x] Chat route: `edit_file` label, tool-result event, empty-turn confirmation
- [x] Routes: `GET /:id/versions`, `GET /:id/versions/:version/content`,
      `POST /:id/restore` + validation schema
- [x] Asset views surface `version`
- [x] Client: `AssetService` versions/version content/restore; `AssetsView`
      history + restore
- [x] Tests: model, service, tool, routes, client component, e2e
- [x] Migration `20261015000000-create-asset-versions` (collection + unique index)
- [x] `npm run ci` green; browser check at phone width
- [x] Archive plan doc, push, open PR

## Follow-ups

- Uploads: allow editing user uploads with a confirmation affordance (deferred;
  v1 is assistant-generated only).
- Rename-on-edit (the ticket's "slightly different filename" symptom): a future
  `filename` parameter to `edit_file`; v1 keeps the filename stable.
- Provenance of an edit (which session/task made each version) is not recorded;
  versions carry content/size/time only. Deferred until there is a reason.
