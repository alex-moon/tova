# Plan — #232 Fixed model roster + hedged provider racing

## Motivation

Supersedes #218. Replaces tier-based smart routing with a **fixed roster of 3
models**, each on **two providers**, where every chat turn is **raced across
both providers** and the first token wins (the loser is aborted). TTFT is
recorded per (model, provider) and weighted against price to pick the primary
for the next turn. See `alex-moon/tova#232` for the full owner-locked roster and
rationale.

This plan covers **only the #232 foundation**. Per the ticket's own
"Fanned-out tickets" section, deletion of the tier machinery is #233, the admin
roster view is #234, cost joins are #235, evals are #236, LangSmith attribution
is #237, and aux/enrichment is #238. The old tier router stays in place
(coexisting) per the plan-roster.md rationale ("build alongside, then delete").

## Roster (owner-locked, verified live 2026-10-08)

| # | Model | DeepInfra id | Fireworks id | Vision |
|---|-------|--------------|--------------|--------|
| 1 | DeepSeek V4.1 Flash | `deepseek-ai/DeepSeek-V4.1-Flash` | `accounts/fireworks/models/deepseek-v4p1-flash` | both |
| 2 | GLM 5.3 Flash | `zai-org/GLM-5.3-Flash` | `accounts/fireworks/models/glm-5p3-flash` | both |
| 3 | MiniMax M3 | `MiniMaxAI/MiniMax-M3` | `accounts/fireworks/models/minimax-m3` | text-only |

## Grounding facts (verified in-repo)

- Mastra's bundled router supports Fireworks under the provider id
  **`fireworks-ai`**, base URL `https://api.fireworks.ai/inference/v1/`, key
  env `FIREWORKS_API_KEY` (`node_modules/@mastra/core/dist/provider-registry-Bqtxy9sN.js`).
- `parseModelString` splits on the **first** slash only, so
  `fireworks-ai/accounts/fireworks/models/<id>` resolves to provider
  `fireworks-ai` and model id `accounts/fireworks/models/<id>` — the model id is
  **not** validated against the shipped registry. The shipped registry is stale
  (lacks `deepseek-v4p1-flash`), but the live Fireworks API lists all three
  roster models, so racing will resolve.
- `.env` already carries `FIREWORKS_API_KEY` locally and live.
- `buildConnector(provider)` in `mastraService.ts` is provider-agnostic; the
  only provider-specific branch is the Groq multimodal guard. Fireworks takes
  image parts like DeepInfra.

## Decisions

1. **Build alongside, do not delete.** New `rosterConfig.ts` (roster data model
   + weighted score) and `racingService.ts` (hedge/abort/TTFT) land beside the
   existing tier router. Deletion is #233. The chat routes switch to racing;
   the tier code remains until #233.
2. **New `modelroster` collection** keyed by model, carrying a nested
   `providers[]` sub-document (`provider`, `modelId`, `enabled`, `ttftMs`,
   `ttftSamples`, `ttftUpdatedAt`). This is the owner's preferred shape (OQ2:
   per-provider rollup on the routing doc) and keeps model capability/pricing
   once per model rather than duplicated per provider.
3. **TTFT storage: rolling average on the provider entry** (windowed mean via
   `ttftMs`/`ttftSamples`), not a dedicated collection — fewer moving parts, the
   admin view (#234) reads one document.
4. **Weighted score:** `score = (ttftMs || neutral) * pricePenalty`, lower is
   better (owner decision OQ3). `f` is the measured TTFT; the penalty is a
   linear multiplier `(1 + k * price)` with `k` env-tunable
   (`ROSTER_PRICE_PENALTY_K`, default small) so price breaks near-ties without
   dominating latency. Neutral TTFT (no samples yet) uses a configurable
   default (`ROSTER_DEFAULT_TTFT_MS`, default 1000). Primary = lowest score.
5. **Racing:** fire both providers concurrently with an abortable stream; the
   first provider to yield its first content/tool chunk wins; abort the loser
   immediately. Record the winner's TTFT. Falling through the roster on total
   failure reuses the #213 classification (`isOverloadError`,
   `isRateLimitError`, `isPromptSizeError`, `isClientAbort`).
6. **Vision gating:** image turns restrict the roster to `vision: true` models
   (DeepSeek V4.1 Flash, GLM 5.3 Flash) — same capability-gating semantics as
   the current image branch.
7. **Enrichment / aux redesign deferred** to #238. The guard classifier's
   *routing* role is not used by the racing path; `filesLikely`-style
   enrichment is a #238 concern. Racing does not call the guard.

## Done

- [x] Add `fireworks` to `LlmProvider`, connector, config key.
- [x] `ModelRoster` mongoose model + `rosterConfig.ts` (roster reads, weighted
      score, TTFT rollup writes).
- [x] Migration seeding the three roster models with their two providers.
- [x] `racingService.ts`: hedge both providers, abort loser, first-token wins,
      record TTFT.
- [x] Roster fallback across the 3 models on total failure (reuse #213).
- [x] Wire the streaming + non-streaming chat routes onto racing.
- [x] Unit tests for weighted score and race/abort behaviour (deterministic
      injectable streams/timers).
- [x] `npm run ci` exit 0.

## Notes on delivery

- **Non-streaming race was `Promise.allSettled`.** The first cut waited for
  every provider to settle before choosing the first fulfilled result, which
  defeats racing (the slower provider always delayed the turn and array order,
  not resolution order, decided the winner). Replaced with `firstCompletionWin`,
  which resolves on the first provider to fulfil and lets the loser settle
  unawaited. `createCompletion` cannot cancel the loser's HTTP call today, so
  it is ignored rather than aborted (Mastra `generate` takes no abort signal) —
  an accepted, documented limitation.
- **Weighted-score test fixture corrected.** A non-streaming fall-through test
  built its secondary model without prices, so the weighted pick (neutral price
  = penalty 1) chose it as primary and the fall-through never ran. The fixture
  now carries prices like its streaming counterpart.

## Follow-ups

- #233 delete tier machinery; #234 admin roster view; #235 cost per (model,
  provider); #236 evals sweep; #237 LangSmith TTFT; #238 aux + enrichment.
