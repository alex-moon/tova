# Plan — #236 Evals: sweep the fixed roster, not the tier seed universe

## Motivation

Part of the #232 routing replacement (fixed roster + hedged provider racing).
Evals previously derived their sweep universe from the tier seed set
(`SEED_ENTRIES`), and the scheduled default was `openai/gpt-oss-20b` — the guard
model, which has no roster home. #232 locked a fixed 3-model roster served by two
providers each; evals must sweep that roster and stop referencing the retired
guard model.

Issue: [alex-moon/tova#236](https://github.com/alex-moon/tova/issues/236).
Base branch: `epic/roster` (see `docs/plan-roster.md`). Depends on #232 (roster
data model) — merged.

## Current state (evidence, `epic/roster`)

- `sweepModels` (`modelConfigService.ts:57`) was already rewritten by #233 into a
  roster bridge: it enumerates `ROSTER_SEED` as `{ provider, modelId }` rows,
  filtered by requested `RosterProvider`s, de-duplicated. `SEED_ENTRIES` is gone.
- `parseModelsFlag('all')` (`evalRunService.ts:154`) calls `sweepModels` over the
  wired roster providers → the 3 models × 2 providers = 6 rows. This is the done
  behaviour for done-item 1.
- `resolveScheduledModels` (`evalRunService.ts:396`) still falls back to
  `DEFAULT_EVAL_MODEL = 'openai/gpt-oss-20b'` (retired guard model) on deepinfra.
- `scripts/run-evals.ts:75` has the same retired default.
- `scripts/eval-model-compare.ts:22` `DEFAULT_REFS` are old small/groq models
  (`deepinfra/Qwen/Qwen3-14B`, `groq/openai/gpt-oss-20b`).
- `src/server/evals/*` (cases, graders, mongoSource, runCase, types) has **no
  tier coupling**; "guard" mentions are hallucination-guard prose, unrelated to
  the retired routing classifier. The golden set is model-agnostic. (OQ3: yes.)
- `EvalResult` already carries both `provider` and `model`; the LangSmith export
  keys examples/runs as `${provider}:${model}`. The eval unit is already
  `(model, provider)` — OQ2 needs no structural change.
- The evals admin "Run now" calls `resolveScheduledModels` server-side; the
  client never picks models. So "admin offers roster models/providers" reduces to
  the server default being roster-shaped.

## Decisions

1. **Default scheduled eval model = GLM 5.3 Flash on DeepInfra.** The retired
   `openai/gpt-oss-20b` has no roster home. GLM 5.3 Flash (`zai-org/GLM-5.3-Flash`)
   is the cheapest roster model ($0.15 + $0.50 = $0.65/mtok on DeepInfra), so
   scheduled eval spend is as low as the roster allows. Chosen over making
   `TOVA_EVAL_MODELS` mandatory: a mandatory var would silently no-op a fresh
   deploy's scheduled run, which is worse than a sane default. Cost is materially
   higher than the old 20B guard model; the owner can override with
   `TOVA_EVAL_MODELS` or `TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER` at any time. Flag
   raised for owner confirmation (see Follow-ups).
2. **`--models all` = the roster on both wired providers (6 runs).** This is what
   `sweepModels` already returns and matches the racing reality (the app races
   providers of one model). `groq` is excluded from the roster sweep (no roster
   rows); the sweep warning already states the wired-provider restriction. The
   CLI's single-run default stays configurable via `TOVA_EVAL_MODEL`.
3. **Eval unit stays `(model, provider)`.** Evals already run and export per
   provider, so they double as the provider-correctness/TTFT evidence base the
   issue flags as valuable. No new dimension is invented.
4. **Golden set unchanged.** It grades tool use and is tier-free; the guard
   prose in graders is the hallucination guard, unrelated to routing tiers.
5. **`eval-model-compare.ts` defaults → roster models on both providers.** The
   old Qwen/groq defaults reference models not in the roster; point them at the
   roster so the ad-hoc comparison tool measures what the app actually routes to.

## Done

- [x] `sweepModels`/universe replaced with the roster (landed in #233).
- [x] Default scheduled eval model decided (GLM 5.3 Flash on DeepInfra) and set
      in `evalRunService.resolveScheduledModels` and `scripts/run-evals.ts`.
- [x] `scripts/eval-model-compare.ts` defaults → roster models on both providers.
- [x] Evals admin "Run now" resolves a roster model (server-side default).
- [x] Eval tests updated (default model, `--models all` roster coverage).
- [x] Docs updated (`.env.example`, `run-evals.ts` header).
- [x] `npm run ci` green (86 server suites / 1063 tests; client clean).

## Follow-ups

- **Owner confirmation wanted (OQ1 cost):** scheduled evals now default to GLM
  5.3 Flash at $0.65/mtok vs the retired 20B guard model. If that is too
  expensive for a daily run, set `TOVA_EVAL_MODELS` to a single
  `provider:model` row or reduce `TOVA_EVAL_SCHEDULE`.
- Evals run per `(model, provider)`; a future ticket could roll the provider
  dimension into a per-model summary once racing has live data to compare.
