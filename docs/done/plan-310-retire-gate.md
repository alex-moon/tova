# Plan — #310 Retire the enrichment gate

The gate's false-negative class (all five #289 misses; "What is my favourite
colour?" → silent no-memory) outweighs its remaining functions, and #305's
rerank-and-cut now supplies the relevance bar — including the cut-everything
refusal the bare-deixis product rule needs. Workspace retrieval runs
unconditionally on every non-ZDR text turn.

## What dies

- The aux vote: `enrichmentVotes`, `classifyFileIntent(Strict|ForEval)`,
  `ENRICHMENT_VOTE_PROMPT`, the parsers, `isEnrichmentEnabled`,
  `classifyWithinTimeout` — the whole aux pre-pass. One less provider call on
  every text turn; memory stops depending on a 20B model's opinion of "past
  work".
- The `files` vote + library-index injection: `enrichmentLibraryBlock`,
  `libraryIndexFor`, `fileLibraryIndex`, and `buildSystemContent`'s library
  slot. Content is retrievable via `kind: 'file'` workspace slices; discovery
  stays with the `list_files` tool.
- Env: `ENRICHMENT_ENABLED` / `ENRICHMENT_TIMEOUT_MS` (config, .env.example,
  docs/overview.md). `AUX_MODEL`/`AUX_PROVIDER` stay (title/metrics/followups).
- The #289 gate stage: `runGateEval` + gate types/rollup mapping (the
  classifier it measures no longer exists). `GATE_CASES` stays — the labelled
  prompt set is the product-rule record and #305's calibration input.
  `gateModel`/`gateProvider`/`gate` become optional in the rollup contract
  (historical runs keep their values; the admin view renders nothing today).
- The gate eval stage in `run-memory-evals.ts`.

## What changes shape

- `enrichmentService.ts` → `workspaceTraceFacts.ts`: only the #308 trace
  helpers survive. `workspaceGateFrom` re-derives from the retrieval outcome:
  `off` (image turn / kill switch) / `yes` (block non-empty) / `no` (empty —
  no overlap or cut-everything). The `timeout` label is retired (no aux call to
  time out); historical traces still carry it and the view renders it.
- chat routes: `retrieveWorkspaceBlock` is called directly (ZDR keeps its
  read-only read; image turns keep `off`); the guard's sessionId threading dies
  with the aux call. Title/metrics/followups keep their threading.

## Merge-evidence numbers (gate-on baseline, from the #305 run)

Gate precision 75.0% / recall 92.3%; retrieval surfacedRate 68.2% (gate-on,
rerank live) — identical to the BM25 baseline, i.e. the gate bought zero
retrieval quality and cost an aux round-trip per turn. Gate-less retrieval is
expected to match or beat that; the eval re-run reports it.

## Verification

- `npm run ci` green (route tests updated for no-vote wiring).
- `npm run evals:memory` retrieval stage only; bare-deixis pairs stay quiet via
  the cut (probe numbers in the #305 plan doc).
- Playwright not needed — no client change (the Memory column renders the same
  metadata keys with re-derived labels).
