# Plan — #235 Cost tracking: price per (model, provider) under racing

## Motivation

Part of the #232 epic (fixed roster + hedged provider racing). Cost was joined
against a **single price on a `providerrouting` row**, keyed by model name only
(`traceStatsCost.ts`, `sessionCostService.ts`). Once a model has **two providers
with different prices**, a model-only join is wrong: the price that actually
applied is the winning provider's.

`Message.provider` is already persisted per assistant turn (#117), so the
winning provider is known. The gap is that the *price lookup* cannot distinguish
two providers of one model.

Ticket: #235 (targets `epic/roster` per `docs/plan-roster.md`).

## Context / current state

- Cost services join `ProviderRouting` (tier-era rows) by `model` alone:
  `traceStatsCost.ts:67-77` and `sessionCostService.ts:99-113`, both using
  `pickPriceRow` (`traceStatsCost.ts:29`) to pick **one** row per model.
- `Message.provider` is persisted (`models/Message.ts:34`), lowercase provider
  name; the racing runtime writes it on the winner (`racingService.ts`).
- The roster (`models/ModelRoster.ts`) owns capability flags and **per-model**
  `inputPrice`/`outputPrice`; providers nest under `providers[]` but carry no
  price yet.
- `#233` deleted the tier routing path and left `ProviderRouting` in place only
  for the admin Models tab (#234 moves that to the roster) and these cost
  services. `#233` decision 4 explicitly deferred the price rewrite to **#235**:
  "`#235` owns the roster price path".
- `AdminSessionCostRow` / `AdminLangsmithModelStats` carry
  `estimatedCostUsd` only; no provider dimension.

## Decisions

Grounded in the code above and web-verified provider facts (2026-10-08).

1. **OQ (proposal 2) — per-provider prices live on the roster provider entry.**
   Add optional `inputPrice`/`outputPrice` to `rosterProviderSchema`. The
   per-model root prices stay as the *default/fallback* so a model registered
   before per-provider pricing still prices. `ROSTER_SEED` gains per-provider
   prices for both backends.

2. **Price lookup keyed by (model, provider), model-only fallback.** A new
   shared resolver maps `(modelName, provider?)` → `PriceLookup`. When a
   provider is given it selects that provider's entry; when the provider is
   unknown/absent (legacy rows) it falls back to a deterministic model-only
   pick (prefer a fully-priced provider, then provider name), preserving the
   pre-#235 behaviour. Unknown price stays `null` (#199 unknown ≠ free).

3. **Source of truth is the roster, not `providerrouting`.** Both cost services
   read `ModelRoster` (falling back to `ROSTER_SEED` on an empty/unreadable
   collection, mirroring `listRoster`). This retires the last non-admin reader
   of `ProviderRouting`; the collection/model itself stays until a later
   cleanup (admin #234 already moved to the roster).

4. **OQ1 — legacy messages price from their persisted provider, else the
   model default.** Old completions were always DeepInfra, and `Message.provider`
   is stored, so back-fill is unnecessary: a legacy message prices by
   `(model, provider)`, and a message with no provider falls back to the model
   default. Documented, not mutated.

5. **OQ2 — sessions keep a single blended figure; provider is not a new
   dimension.** A session aggregates turns that may have raced either provider.
   Breaking the row down by provider is a larger contract/UI change with no
   stated need; the blended total is correct because each turn is priced by its
   *winning* provider. The LangSmith model rollup stays model-keyed for the same
   reason, and because the trace may not encode the provider (see #237, OQ1).

6. **Fireworks seed prices are evidence-based, DeepSeek flagged.** From the
   official Fireworks serverless pricing docs (2026-07-13, in/cached/out per
   1M): GLM 5.3 Flash `$0.15/$0.03/$0.50`, MiniMax M3 `$0.30/$0.06/$1.20`. The
   DeepSeek V4.1 Flash row reads `$0.30/…/$1.20` in the official table, but
   third-party aggregators (requesty, computeprices) list `$0.22/$0.66`. We use
   the **official docs** values and flag the discrepancy in the PR for owner
   confirmation rather than silently picking the cheaper figure.

7. **OQ5 — no hard $1.50 cap is reintroduced.** Price remains a soft score term
   (`rosterConfig.rosterScore`). Unchanged by this ticket.

8. **OQ4 — only the winner is priced.** The race loser's partial spend is not
   persisted (no run row), so it cannot be priced; accounting covers winning
   turns. Documented, unchanged.

## Done

- [x] `ModelRoster` provider entries carry optional `inputPrice`/`outputPrice`;
      `ROSTER_SEED` + the seed migration gain per-provider prices.
- [x] Shared `(model, provider)` price resolver reads the roster
      (`buildPriceIndex`/`priceFor`/`loadPriceIndex` in `traceStatsCost`); both
      `traceStatsCost` and `sessionCostService` use it and drop `ProviderRouting`.
- [x] `sessionCostService` groups by `(session, model, provider)` so each turn
      prices by its winning provider.
- [x] Contracts/docs updated where the provider-aware pricing must be legible;
      blended session/model figures retained (decision 5); session-cost UI note
      now states per-turn provider pricing.
- [x] Tests: dual-price model prices by persisted provider (unit + route);
      unknown provider falls back; unknown price stays `null`; migration/seed
      drift pinned (incl. per-provider prices).
- [x] `npm run ci` green (86 server suites / 1057 tests; client build clean).

## Notes on delivery

- The `providerroutings` model itself is not deleted here: `admin.ts` still
  reads it on `epic/roster` until #234 (open PR #241) lands the roster tab. This
  ticket removes the last *cost-service* reader; a later cleanup can drop the
  collection once #234 merges.
- The Fireworks DeepSeek price (`$0.30/$1.20`) is from the official Fireworks
  serverless pricing table; third-party aggregators list `$0.22/$0.66`. Flagged
  in the PR for owner confirmation (decision 6); GLM and MiniMax match across
  sources.
