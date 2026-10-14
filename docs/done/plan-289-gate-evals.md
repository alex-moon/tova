# Plan — #289 Workspace memory: gate evals and thresholds

> **Archived 2026-10-14** (PR #303 merged; remaining work moved to #306 —
> forward plan: [plan-306-eval-closeout.md](../plan-306-eval-closeout.md)).

> The remaining work on #289 is re-planned in
> [plan-289-workspace-memory.md](./plan-289-workspace-memory.md); where the two
> differ, that document is the forward plan.

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
     (and deletion) fails — the headroom #294 is measured against. #293 has already
     landed and flipped `out-of-pool` from a miss to a hit (whole-corpus BM25).
   - **Stage 3 — helpfulness (mixed).** Scenarios carry the expected fact (deterministic
     substring) and are shaped for the pairwise A/B + blinded, position-swapped judge
     (`openai/gpt-oss-120b` on Groq). The judge is **wired but not yet validated** against
     hand labels (OQ1); its win-rate is provisional until that validation clears (see the
     Stage 3 section below).

2. **Hit-rate needs slice IDs, so retrieval is split.** `retrieveWorkspaceBlock` returns
   a rendered string, not the picked slices. Extract `collectWorkspaceSlices(...)` and add
   `retrieveWorkspaceSlices(...)` returning the picked `WorkspaceSlice[]` (with `id`).
   `retrieveWorkspaceBlock` keeps its exact behaviour (it now calls the same collector),
   so the chat routes are unchanged.

3. **Scenario isolation by reseeding.** Each retrieval scenario clears the eval fixture
   user's memory collections, materialises only its own seeds, and runs its query — so one
   scenario's seeds cannot contaminate another's hit-rate. `deleted-seed` materialises a
   soft-deleted session (excluded by `deletedAt`); `out-of-pool` buries its seed under
   many newer messages, which excluded it under the pre-#293 bounded read — since #293
   reads the whole corpus it surfaces.

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

Built: corpus (types + data), Mongo seeder/clearer, the retrieval-ID split, the
deterministic gate + retrieval runner, the stage-3 helpfulness runner (deterministic
backbone + blinded/position-swapped judge, manual-only), the LangSmith corpus export,
and a CLI.

Deferred (follow-ups on #289): judge validation against hand labels; persisting
metrics to a rollup; the assistant-turns corpus decision; the go/no-go on
`WORKSPACE_MEMORY_ENABLED`.

## Baseline (2026-10-14, local stack, n grown)

`npm run evals:memory` against the current gate + retrieval (corpus since grown;
n=8 was noise, this is the first real read):

- **Stage 1 — gate:** precision 100%, recall 83.3%, fireRate 41.7% (n=36, 18 pos /
  18 neg). The three misses are all false negatives: `gate-other-one` ("use the
  other one instead") and `gate-one-from-yesterday` (bare deixis, no history in
  the input the gate sees — see OQ12), and `gate-finish-draft` (a continuation
  whose refer-back is in `history`).
- **Stage 2 — retrieval (re-captured after the #293/#294 rebase):** expectedMet
  77.3%, surfacedRate **68.2%** (n=22). `direct` 3/3, `file` 5/5, `task` 5/5 and
  `out-of-pool` 2/2 surface (#293's whole-corpus BM25 reaches the buried seed);
  `paraphrase` 0/5 is the remaining lexical gap (#294 embeddings/vector closes it);
  `deleted-seed` 0/2 is the only miss by construction (`deletedAt`).
- Corpus pushed to the LangSmith `tova-memory-evals` dataset.

> **Rebase note (2026-10-14).** #293 (BM25) and #294 (embeddings/vector) have merged
> to `main`; the branch was reconciled onto them. Under #293 the bounded-pool
> `out-of-pool` category is no longer a miss by construction, so both
> `out-of-pool` scenarios now carry `expectSurfaced: true` and the retrieval
> baseline above is the post-#293 read. With `WORKSPACE_MEMORY_ENABLED` off (the
> default) the vector stage is disabled and stage 2 is the BM25 baseline; the
> `paraphrase` misses stand until the flag is on and an Atlas index exists.

These are the provisional-50% measurements, not the ship bars: the go-live bars are
ratified from the evidence (ticket: "baseline first, then ratify"). Every bar needs
a stated minimum N; n=36 gate / n=22 retrieval now clear the per-category floors
pinned in `corpus.test.ts`.

> **Provenance caveat (2026-10-14).** The gate numbers above were captured *before*
> the T1b-i subtype annotation landed, which changes the corpus hash. A later local
> run on the annotated corpus read recall 88.9% (two misses: `gate-one-from-yesterday`,
> `gate-finish-draft`) — the `gate-other-one` flip is provider run-to-run variance
> (OQ26), not a corpus change. The baseline is re-captured on the annotated corpus as
> T9 in `plan-289-workspace-memory.md`; treat the numbers here as the pre-annotation
> record.

## Stage 3 — helpfulness (wired, not yet validated)

`evals/memory/helpfulnessEval.ts` runs the ticket's mixed stage: the same query
answered **with** and **without** the retrieved block, then a blinded,
position-swapped pairwise judge over the holistic delta.

- **Deterministic backbone:** the with-arm block must carry the expected slice id
  (read via `retrieveWorkspaceSlices`, since the rendered block carries no ids) and
  the expected fact; `factInBlock`/`factHitWith` record it. The fact check is
  `normaliseFact` (casefold + whitespace-collapse), so a fact split by a newline
  or double space is not a layout false miss (T14a).
- **Counterfactual is run, not assumed:** `counterfactualHit` flags a without-arm
  that already answers correctly — injection did not help and a judge-only setup
  would never see it.
- **Blinded + position-swapped:** the judge is told nothing about which arm had the
  block and every pair is judged twice with the arms swapped. `resolveSwappedOutcome`
  counts only an order-consistent win as a win; a flip (or a judge `tie`) is a tie.
  Ties score 0.5 in `winRate` (OQ3's provisional rule). A failed presentation
  (empty/unparseable reply or a thrown call) is an **`error`**, distinct from a
  `tie` and excluded from the win-rate denominator (T14b/OQ20).
- **Judge model:** `openai/gpt-oss-120b` on Groq, from `config.memoryEval`
  (`MEMORY_JUDGE_MODEL`/`MEMORY_JUDGE_PROVIDER`), deliberately not the gate model
  `openai/gpt-oss-20b`. Same-family independence is OQ2 (owner-gated). The judge
  budget is 512 tokens: at the original 16 the reasoning model returned an empty
  completion (CoT truncated before the verdict), which the preflight caught live
  (OQ21). `npm run evals:memory -- --preflight-judge` asserts a parseable verdict
  in both orders before a run is trusted (T14d).
- **Responder + pacing:** the responder is the roster default, overridable via
  `config.memoryEval.responder*` (T14c); live responder/judge calls are paced by
  `MEMORY_EVAL_PACE_MS` (default 1000ms, T15d) to stay under the provider RPM.
- **Manual-only:** runs via `npm run evals:memory -- --helpfulness`; the default
  deterministic path is unchanged, and the scheduled suite does not yet include it
  (OQ6). The judge is **wired but not trusted**: it must be validated against
  ~30–50 hand-labelled pairs (OQ1) before its win-rate ratifies a bar.

## Open questions (owner-gated — do not decide silently)

These gate threshold ratification, not implementation. Recorded so the plan and the
issue stay in sync:

- **OQ1 label independence** — who authors/validates the hand labels (gate set,
  judge-validation pairs, scenario expectations)? Agent-authored labels are marked
  `note: 'agent-authored'` in `corpus.ts` so the provenance is auditable; whether
  that counts as "hand-labelled" is the owner's call.
- **OQ2 judge independence** — is `gpt-oss-120b` (same family as the gate
  `gpt-oss-20b`) independent enough, or is a different family required? The judge id
  is config-sourced, so this is a config change.
- **OQ3 position-swap scoring** — order-disagreement is provisionally a tie (0.5);
  confirm, or count it as a loss and/or make ties 0.
- **OQ4 helpfulness bar** — is pairwise win-rate the right bar, and what floor
  (e.g. ≥ 60%)?
- **OQ6 stage-3 scheduling** — should the daily run include the live judge/responder
  calls, or stay manual-only?
- **OQ11 provider rate limits** — `enrichmentVotes` maps *any* failure (incl. a Groq
  429) to `{workspace:false}`, so a rate-limited positive is scored as a gate "no"
  and inflates false negatives. Options: pace/retry, surface failures as a distinct
  excluded outcome, or both.
- **OQ12 bare-deixis fairness** — five positives are bare-deictic with no history
  (`gate-same-as-before`, `gate-other-one`, `gate-and-that-one`, `gate-previous-version`,
  `gate-one-from-yesterday`), so the referent is unresolvable in what the gate sees. The
  subtype is now recorded on every positive (T1b-i), so per-subtype recall is reported;
  the open part is whether bare deixis is a fair `refersBack: true` label at all, or
  whether all five should be relabelled/dropped. `gate-finish-draft` is a `continuation`
  with history and is unaffected. Ties to OQ36 (a bare-deictic negative would collide
  with the bare-deictic positive `gate-and-that-one`).

## Done

- [x] Plan doc (this file)
- [x] `workspaceRetrievalService`: `collectWorkspaceSlices` + `retrieveWorkspaceSlices`
- [x] `evals/memory/`: types, synthetic corpus (gate + scenarios), tests
- [x] `evals/memory/memorySource.ts`: seed/clear scenarios in Mongo
- [x] `evals/memory/memoryEvalService.ts`: gate + retrieval runner with metrics
- [x] `evals/memory/helpfulnessEval.ts`: stage-3 runner (both arms, counterfactual,
      blinded + position-swapped judge) with `config.memoryEval` judge id
- [x] `pushMemoryCorpusToLangSmith` (`tova-memory-evals`)
- [x] `scripts/run-memory-evals.ts` + `npm run evals:memory` (+ `--helpfulness`)
- [x] `npm run ci` green
- [x] Baseline run recorded above (gate n=36, retrieval n=22)

## Follow-ups

Deferred to [plan-289-workspace-memory.md](./plan-289-workspace-memory.md),
which carries the task checklist and the current baseline. In short: grow/ratify
the gate set (OQ12/OQ36), validate the stage-3 judge against hand labels (OQ1),
persist memory metrics into the `evalruns` rollup and surface them in the admin
Evals tab, wire the memory stage into the scheduled suite, decide the
assistant-turns corpus question, and make the `WORKSPACE_MEMORY_ENABLED=1`
go/no-go call. The retired list (kept for history): validate the stage-3 judge
(`gpt-oss-120b` on Groq) against ~30–50 hand-labelled pairs; persist memory-eval
metrics; decide the assistant-turns question; go/no-go on live.
