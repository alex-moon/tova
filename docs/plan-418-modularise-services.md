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

- [x] Iteration 1: six prefix groups moved, imports rewritten (287 specifiers across 87
  files), tests mirrored
- [x] Iteration 2: llm/, web/, content/ + absorptions (232 specifiers across 90 files)
- [x] Iteration 3: connectors/ unlocked via the root toolDegrade contract;
  metrics/subtitle/honestyGuard/promptMetrics reclassified into llm/; sessionCostService
  into trace/
- [x] `npm run ci` green (ran whole once — failed at server lint — then per-side: `ci:server` + `ci:client`)

## Iteration 2 — dependency-traced grouping

Second pass guided by the actual import graph, not name prefixes. New groups:

- `llm/` — llmTypes, inferenceService, mastraService, auxCompletion, chatRace,
  outputTokenCap, toolChips, toolDegrade, calculator, titleService, followupService,
  promptAssembly (llmTypes is the hub; title/followup are aux-completion consumers)
- `web/` — webFetchService, webSearchService, firecrawlService, safeLinkService,
  geoLocationService (only entered via mastraService/firecrawl)
- `content/` — textExtraction, markdownConversion, documentUnits, pdfRasterize, ocr,
  imageThumbnail, subtitleService, attachmentEnvelope (markdownConversion hub)

Absorbed into existing groups where the consumer tree demanded it:
`embeddingService`/`atlasVectorIndex`/`rerankerService`/`workspaceTraceFacts` →
`workspace/`; `providerErrors` → `model/`; `systemAssetService` → `asset/`.

Deliberately left flat: the connectors trio (connectorService, oauthConnectors, crypto —
grouping them would cycle against llm/ via toolDegrade) and observability leftovers
(metricsService → auxCompletion would cycle the same way); shared kernel logRedaction,
clampError, sleep, cursorPage; boundary-protected storageService; route-facing singles
userService, userDataPurge, zdrTurn, honestyGuardService.

## Iteration 3 — resolving the cycles by reclassification

The two cycle tensions from iteration 2 both dissolved under scrutiny:

- `toolDegrade` is not llm/ or connectors/ code — it is the **contract between them**
  (per-completion tool-failure state on mastra's requestContext, honored by both the
  agent runner and the MCP executor, which use the same four exports). It moved back to
  the services root, letting both domains import "up" to a shared seam. That unlocked
  `connectors/` (connectorService, oauthConnectors, crypto) with a strictly acyclic
  directory graph.
- `metricsService` was misfiled as observability by lexicon — it actually runs the aux
  model to classify prompts (a chat-analytics feature, consumer: chat route). It went to
  `llm/` with its satellite `promptMetrics`, dissolving the metrics cycle by
  reclassification rather than tolerance.
- `subtitleService` and `honestyGuardService` joined `llm/` for the same shape:
  chat-route features whose engine is auxCompletion (the "content" in subtitleService's
  name had seduced it into the extraction pile).

Left flat, by the same evidence: logService, lokiLogs, langsmithTracesService,
langsmithDataset (no mutual import edges — grouping them would be lexical, exactly what
this pass exists to avoid), plus the shared kernels logRedaction, clampError, sleep,
cursorPage, the toolDegrade contract, boundary-protected storageService, and
route-facing userService, userDataPurge, zdrTurn.

## Deviations found during iteration 1

- `eslint.config.js` storage-boundary ignore (#149) was keyed to the old flat path
  `services/workspaceStorage.ts` — updated to `services/workspace/workspaceStorage.ts`
  (and the rule's message path).
- `evalRunService.ts` `defaultReadRepoFile` anchored the repo root at
  `__dirname + 4×'..'` (resolving to `apps/`, with the `@repo:../` marker correcting to
  the true root); the move added a directory level, so it is now 5×`'..'`. Pinned by the
  `cases.test.ts` "@repo: markers resolve" test, which caught it.
