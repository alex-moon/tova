# Plan — #234 admin Models + Compare tabs for the fixed roster

## Motivation

Part of the #232 epic (fixed model roster + hedged provider racing). The admin
Models tab still operates on tier-shaped `providerroutings` rows
(`{tier, provider, model}`) with a feedback-per-band column, and the Compare tab
filters out `guard` rows and labels entries `provider/model (tier)`. With the
tier era gone (#233), the admin surface must speak the roster's vocabulary:
one row per model, two providers attached, live TTFT per provider, price as a
soft score input rather than a hard cap.

Ticket: #234 (targets `epic/roster` per `docs/plan-roster.md`).

## Context / current state

- Roster data model (`src/server/models/ModelRoster.ts`): one document per
  model, nested `providers[]` (`{provider, modelId, enabled, ttftMs,
  ttftSamples, ttftUpdatedAt, disabledUntil}`), plus per-model `tools`/`vision`/
  `contextLength`/`inputPrice`/`outputPrice`/`eligible`. Seeded from
  `ROSTER_SEED` (`src/server/services/rosterConfig.ts`).
- `src/server/routes/admin.ts` `/models` still reads `ProviderRouting` and emits
  `tier` + `stats: []` (placeholder left by #233). CRUD POST/PUT/DELETE accept
  `tier`. `model-lookup` is DeepInfra-only. `model-compare` is already tier-free.
- `AdminModel` (`src/shared/contracts.ts:35`) still carries `tier` and `stats`.
- `src/client/src/components/AdminView.tsx` Models tab renders tier + feedback
  columns, an over-cap badge (#199), catalog lookup/refresh (#217), and the
  endpoint-error table (#168/#175). Compare filters `m.tier !== 'guard'`.
- Weighted score (`rosterConfig.rosterScore`): `TTFT × (1 + k × price)`, lower
  better; unknown TTFT uses a neutral default, unknown price is neutral (not
  free). `pickPrimary` picks the best-scoring model.

## Decisions

Grounded in the code above and web-verified provider facts.

1. **OQ1 — doc shape: one row per model, nested `providers[]`.** The roster doc
   is already per-model; admin mirrors it. `AdminModel` drops `tier` and `stats`,
   gains `providers[]` and per-model capability/pricing fields. `id` becomes the
   roster `_id`; `modelId` is the stable key.
2. **OQ2 — add a Fireworks resolver; prices stay DeepInfra-sourced.** Verified
   2026-10-08: Fireworks exposes `GET /v1/accounts/{account_id}/models` returning
   `{models:[{name, displayName, description, contextLength, supportsImageInput,
   supportsTools, ...}], nextPageToken, totalSize}` — **capabilities and context,
   but no token pricing**. DeepInfra's catalog carries context + prices + vision.
   So the add/refresh flow resolves both providers: DeepInfra supplies
   context/prices/vision; Fireworks supplies context/vision/tools only, prices
   left unknown (neutral in the score). A hand-entered price remains possible.
   This keeps the "unknown ≠ free" stance and avoids inventing prices.
3. **OQ3 — TTFT shown exactly as the router uses it.** Per provider, the rolling
   mean `ttftMs` and `ttftSamples` (and `ttftUpdatedAt`), straight from the
   routing doc. No client-side recomputation, so operators see the same figure
   `pickPrimary` scores on.
4. **OQ4 — no hard cap; price is a soft score input.** The #199 $1.50 cap
   excluded tier-era pool rows. The roster scores price as a penalty factor, so
   the over-cap badge and client cap constant are removed. Price is shown as
   plain info alongside the per-model weighted score.
5. **OQ5 — providers are edited independently.** Each provider row carries its
   own `enabled` toggle; disabling one backend leaves the model racing on the
   other (matches `liveProviders`).
6. **OQ6 — Compare runs the roster, per provider entry.** Each entry is a
   `provider/modelId` pair, so a 3-model roster offers up to 6 entries — the same
   set that actually races. The endpoint already takes arbitrary provider/model
   pairs; the Fixworks connector is wired in `mastraService`/`inferenceService`.

## Done

- [x] `AdminModel` contract: drop `tier`/`stats`; add `providers[]`
      (`{provider, modelId, enabled, ttftMs?, ttftSamples?, ttftUpdatedAt?,
      disabledUntil}`) and per-model `modelId`/`label`.
- [x] `GET /api/admin/models` reads `ModelRoster` (models + `ModelRouteError`).
- [x] Model CRUD rewritten against `ModelRoster`: create resolves both provider
      configs; update handles eligibility + per-provider enable (merging on the
      provider key so TTFT/cool-off survive an edit); delete by `id`.
- [x] `model-lookup` gains a Fireworks resolver (`provider` query param accepts
      `deepinfra` | `fireworks`).
- [x] Models tab reworked: provider list with live TTFT + price, per-provider
      enable, eligible toggle, vision/tools badges, per-provider cool-off badge,
      catalog lookup/refresh (#217), endpoint-error table. Tier dropdown,
      feedback column and over-cap badge removed.
- [x] Compare tab lists roster provider entries (no guard filter); a 3-model
      roster offers its six raced backends; runs via the shared
      `model-compare`.
- [x] Add-flow resolves BOTH provider catalogs in parallel (DeepInfra prices,
      Fireworks capabilities); a transport failure on both surfaces as an error
      rather than a misleading "not found".
- [x] Server + client tests updated; Playwright render at 390px phone width
      (Models + Compare tabs, no horizontal overflow). Note: an unrelated
      React-Compiler `preserve-manual-memoization` lint error on the Graph tab's
      `openGraphDetail` surfaced once the file was otherwise clean, fixed by
      listing the stable `setGraphDetail` setter in its dep array.
- [x] `npm run ci` green (86 server suites / 1054 tests; 18 client suites / 235
      tests).

## Follow-ups

- `#235` owns per-(model, provider) price storage/costing; this plan leaves
  Fireworks prices unknown rather than inventing them.
- `#236` sweeps the roster in evals; the admin Compare stays manual.
