# Plan — #418: Modularise services

Branch: `feat/tv/418-modularise-services`

`apps/server/src/main/services/` holds 82 flat files (plus a `fixtures/` dir). Group the
files sharing a common prefix into subdirectories; leave everything else flat. Pure
moves only — no export renames, no service merging, no barrel `index.ts` files.

## Scope

Six groups, confirmed in ticket discussion:

- `task/` — taskService, taskProcessor, taskSequencer, taskNotificationService
- `asset/` — assetConfirm, assetEditService, assetJobProcessor, assetJobService,
  assetLimits, assetPresign, assetThumbnails, assetVersionPrune, assetViews, assetZip
- `workspace/` — workspaceEmbeddingBackfill, workspaceEmbeddingIngest,
  workspaceEmbeddingText, workspaceRetrievalService, workspaceStorage
- `eval/` — evalRunService, evalRunsAdminService, evalScheduler, memoryEvalRunService
  (distinct from `main/evals/`, which holds the evals themselves — that split stands)
- `trace/` — tracePurge, traceRedaction, traceStatsCacheService, traceStatsCost
- `model/` — modelDefaults, modelErrorTally, modelFailover, modelCompare

Filenames stay as-is inside groups (`services/task/taskProcessor.ts`), so git sees pure
renames and greps keep working. Singles (lokiLogs, langsmith*, ocr, rerankerService, …)
stay flat — no forced taxonomy for 1–2 file groups. `fixtures/` stays put.

## Mechanics

Per group: `git mv` the files, then rewrite the three import shapes —

1. sibling imports inside services (`./taskProcessor` → `./task/taskProcessor`)
2. imports from other main dirs (`../services/taskProcessor` →
   `../services/task/taskProcessor`)
3. mirrored test-tree imports + move specs to `src/test/services/task/` etc.

TypeScript is the safety net: every missed import is a compile error. After all groups,
`npm run typecheck` for fast feedback, then the full `npm run ci` gate once.

## Done

- [x] Six groups moved, imports rewritten (287 specifiers across 87 files), tests mirrored
- [x] `npm run ci` green (ran whole once — failed at server lint — then per-side: `ci:server` + `ci:client`)

## Deviations found during the move

- `eslint.config.js` storage-boundary ignore (#149) was keyed to the old flat path
  `services/workspaceStorage.ts` — updated to `services/workspace/workspaceStorage.ts`
  (and the rule's message path).
- `evalRunService.ts` `defaultReadRepoFile` anchored the repo root at
  `__dirname + 4×'..'` (resolving to `apps/`, with the `@repo:../` marker correcting to
  the true root); the move added a directory level, so it is now 5×`'..'`. Pinned by the
  `cases.test.ts` "@repo: markers resolve" test, which caught it.
