# Plan: #369 Filename-based file access + duplicate-filename versioning

## Motivation

[#369](https://github.com/alex-moon/tova/issues/369): the agent must map a filename it already
has to an id it doesn't before it can touch a file, and `generate_file` with an existing name
creates an independent duplicate row instead of updating the file the user (and agent) thinks
of as "the" file.

## Decisions

- **Read and edit accept `filename`** (`read_file`/`edit_file` gain an optional `filename`;
  `id` stays). Resolution: a valid id wins, else the newest ready row with the sanitized
  filename across the caller's library (uploads, generated files, cached pages — everything
  `list_files` shows). Neither resolves → `not_found`.
- **Duplicate generated filenames become versions, not rows**: `generate_file` with the
  sanitized filename of an existing **system-generated** file writes the content as a new
  version via the existing `writeAssetContent` (snapshot + Spaces overwrite + re-ingest + id
  preserved) — "deprecating" the previous version. The version output field is exposed.
  Collisions with non-generated rows (user uploads, agent-side cache) still create separate
  rows: the agent must not silently overwrite content it didn't create.
- **Old versions stay invisible to the agent** — already true (`AssetVersion` is never read by
  any tool; the row always mirrors the latest); nothing to build, just preserved.
- **Version pruning**: a daily sweep deletes `AssetVersion` rows older than one year **where a
  newer version of the same asset exists** (aggregate max-version per asset, bulk delete).
  Own small poller module following the traceStatsPoller pattern, started in `index.ts` under
  the existing non-test gate. Restore functionality is not built (#369 leaves the door open).
- **Known race**: two concurrent `generate_file` calls with the same fresh name can both
  create rows (no unique index across origins is possible without more schema work); accepted
  — the duplicate path is a convenience, not an invariant.

## Done

- [x] `read_file` / `edit_file`: optional `filename` resolution
- [x] `generate_file`: duplicate-name → new version of the existing generated row
- [x] Daily version-prune worker (>1y, newer version exists) wired into `index.ts`
- [x] Tool-level tests for all three behaviours + prune sweeper
- [x] `npm run ci` green

## Follow-ups

- Restore-an-old-version UX (user-facing) — deliberately not built (#369 mentions it as a
  possible later feature).
