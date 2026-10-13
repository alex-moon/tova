# Plan — #289 Workspace memory: gate evals and thresholds

Issue: [alex-moon/tova#289](https://github.com/alex-moon/tova). Epic: #251.
Follow-up to #253 (workspace memory). Retrieval-ranking follow-ups: #293, #294.

## Motivation

`WORKSPACE_MEMORY_ENABLED` ships default-off because a wrong injection pollutes every
turn. The flag cannot go on live until there is *evidence*, and the #253 plan is explicit
that the gate "must be evaluated, not intuited". This slice builds the evaluation: a
golden corpus and the deterministic stages that score the gate (precision/recall),
retrieval (hit-rate by slice ID), and — encoded but not yet executed — injection
helpfulness.

The corpus is modelled on the owner's real production usage (issue comment, 2026-10-13):
facts seeded in longer-lived chats, probed from fresh chats that are then deleted. The
checked-in corpus uses **synthetic analogues** (same structure, no personal data).

## Decisions

1. **Three stages, encoded in one corpus module; two run now.**
   - **Stage 1 — gate (deterministic).** Hand-labelled `prompt → refers back yes/no`;
     compare `enrichmentVotes(...).workspace` to the label. No LLM judge (and never the
     gate model itself — self-preference).
   - **Stage 2 — retrieval hit-rate (deterministic).** Each scenario seeds known slices
     and asks a query whose answer requires one of them; hit = did retrieval surface the
     expected slice ID. Scenarios are tagged `direct`, `paraphrase`, `file`, `task`,
     `deleted-seed`, `out-of-pool` so the baseline shows exactly where lexical retrieval
     (and deletion, and the bounded pool) fails — the headroom #293/#294 are measured
     against.
   - **Stage 3 — helpfulness (mixed).** Scenarios carry the expected fact (deterministic
     substring) and are shaped for the pairwise A/B + blinded, position-swapped judge
     (`openai/gpt-oss-120b` on Groq). **The judge is not wired in this increment** — the
     ticket requires validating it against hand labels first. The data is encoded so the
     judge runner is a drop-in follow-up.

2. **Hit-rate needs slice IDs, so retrieval is split.** `retrieveWorkspaceBlock` returns
   a rendered string, not the picked slices. Extract `collectWorkspaceSlices(...)` and add
   `retrieveWorkspaceSlices(...)` returning the picked `WorkspaceSlice[]` (with `id`).
   `retrieveWorkspaceBlock` keeps its exact behaviour (it now calls the same collector),
   so the chat routes are unchanged.

3. **Scenario isolation by reseeding.** Each retrieval scenario clears the eval fixture
   user's memory collections, materialises only its own seeds, and runs its query — so one
   scenario's seeds cannot contaminate another's hit-rate. `deleted-seed` materialises a
   soft-deleted session (excluded by `deletedAt`); `out-of-pool` buries its seed under
   `MESSAGE_POOL` newer messages (excluded by the bound).

4. **The corpus is loadable in the existing harness.** A `pushMemoryCorpusToLangSmith`
   exports the scenarios (seeds + query + expected) as examples on a `tova-memory-evals`
   dataset, mirroring `pushToLangSmith`/`tova-evals`; the CLI prints the deterministic
   metrics locally. Persisting metrics into the `evalruns` rollup (whose per-case shape is
   `pass|partial|fail`) is **deferred** — precision/recall@k/win-rate do not fit that
   shape and the rollup change is a separate decision.

5. **Baseline thresholds stay provisional.** This increment produces the *numbers*; the
   ship bars are ratified from the baseline run, not set here (ticket: "baseline first,
   then ratify the go-live bars from the evidence").

## Scope of this increment

Built here: corpus (types + data), Mongo seeder/clearer, the retrieval-ID split, the
deterministic gate + retrieval runner, the LangSmith corpus export, and a CLI.

Deferred (follow-ups on #289): the stage-3 judge runner + judge validation; persisting
metrics to a rollup; the go/no-go on `WORKSPACE_MEMORY_ENABLED`.

## Baseline (2026-10-13, local stack)

`npm run evals:memory` against the current gate + retrieval:

- **Stage 1 — gate:** precision 100%, recall 100%, fireRate 50% (n=8). **Caveat:** eight
  easy cases is below any minimum-N bar (a percentage over single digits is noise). The
  gate set needs harder positives (indirect refer-backs) before these numbers mean
  anything.
- **Stage 2 — retrieval:** expectedMet 83.3%, surfacedRate 50% (n=6). The misses are the
  designed ones: `paraphrase` (no lexical overlap — the gap #293/#294 close) and
  `deleted-seed` / `out-of-pool` (excluded by construction). `direct`, `file`, and `task`
  all surface.
- Corpus pushed to the LangSmith `tova-memory-evals` dataset.

These are the provisional-50% measurements, not the ship bars: the go-live bars are
ratified from a larger, harder baseline (ticket: "baseline first, then ratify").

## Done

- [x] Plan doc (this file)
- [x] `workspaceRetrievalService`: `collectWorkspaceSlices` + `retrieveWorkspaceSlices`
- [x] `evals/memory/`: types, synthetic corpus (gate + scenarios), tests
- [x] `evals/memory/memorySource.ts`: seed/clear scenarios in Mongo
- [x] `evals/memory/memoryEvalService.ts`: gate + retrieval runner with metrics
- [x] `pushMemoryCorpusToLangSmith` (`tova-memory-evals`)
- [x] `scripts/run-memory-evals.ts` + `npm run evals:memory`
- [x] `npm run ci` green (101 suites, 1236 tests)
- [x] Baseline run recorded above

## Follow-ups

- Grow the gate set with harder positives; raise N above the minimum-N bar before
  ratifying thresholds.
- Stage-3 judge runner (`gpt-oss-120b` on Groq), blinded + position-swapped, validated
  against ~30–50 hand-labelled pairs.
- Persist memory-eval metrics (new shape or collection) and surface them in the admin
  Evals tab.
- Go/no-go for `WORKSPACE_MEMORY_ENABLED=1` on live.
