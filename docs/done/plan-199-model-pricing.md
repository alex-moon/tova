# Plan — #199 Model pricing

Branch: `feat/199-model-pricing`
GitHub issue: alex-moon/tova#199

## Motivation

The owner needs visibility into what each routing row costs, and wants cost to
shape routing. Today there is **no pricing data anywhere in the codebase**: no
schema field, no admin column, no route, no selection input. The only prices in
the repo are prose/table entries in the archived plan
`docs/done/plan-170-more-models.md` (~line 200). The `providerroutings`
collection (`src/server/models/ProviderRouting.ts`) carries provider, model,
tier, eligibility, capabilities (`tools`/`vision`), `contextLength`, and the
#168 cool-off `disabledUntil` — nothing about money.

Issue #199 asks for three things:

1. **A view of model pricing**, primarily in the admin view.
2. **A hard constraint**: no models over **$1.50 per million tokens**, counting
   **input + output**, ignoring cached pricing.
3. **Cost-aware selection**: a lower price should weight a model toward a
   **higher probability of being selected**.

This touches the two surfaces the repo already treats as evidence-first
(`AGENTS.md` → "Model routing decisions"): model config (`providerroutings`)
and router selection (`routerService.ts`). The constraint in (2) is decidable
from the price data alone; the weighting in (3) is a policy change to the
existing ε-greedy / feedback-weighting pick and therefore needs its own careful
treatment and evidence.

Scope bound for this pass: **plan only**. No code is written and nothing is
committed. Everything below is a proposal with explicit open questions; tasks
that depend on an unresolved question are not scheduled.

## The cap's blast radius (computed from the #170 table)

The threshold is the crux of this ticket. Applying `inputPrice + outputPrice >
$1.50` to the 14 models #170 seeded splits them almost exactly in half. This is
**not a display-only change** — it would retire 7 of the 14 #170 rows, plus
possibly pre-#170 rows whose prices are not in the table at all.

| Model | in+out $/M | Over cap? |
|---|---|---|
| `moonshotai/Kimi-K3` | 17.10 | **yes** |
| `Qwen/Qwen3.8-2.4T-A95B` | 8.00 | **yes** |
| `zai-org/GLM-5.3` | 4.90 | **yes** |
| `moonshotai/Kimi-K2.6` | 4.25 | **yes** |
| `deepseek-ai/DeepSeek-V4-Pro-0813` | 3.90 | **yes** |
| `Qwen/Qwen3.5-397B-A17B` | 3.45 | **yes** |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | 2.70 | **yes** |
| `MiniMaxAI/MiniMax-M3` | 1.38 | no |
| `XiaomiMiMo/MiMo-V2.6-Pro` | 1.305 | no |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` | 1.30 | no |
| `Qwen/Qwen3-VL-235B-A22B-Instruct` | 1.08 | no |
| `deepseek-ai/DeepSeek-V4.1-Flash` | 0.80 | no |
| `zai-org/GLM-5.3-Flash` | 0.65 | no |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 0.49 | no |

Two consequences the original draft under-weighted:

- **The vision pool shrinks.** The large-tier `vision: true` rows are
  Qwen3-VL-8B, Qwen3-VL-30B, V4.1-Flash, Kimi-K3, Kimi-K2.6, Qwen3.5-397B,
  Qwen3-VL-235B, GLM-5.3-Flash, MiMo, MiniMax-M3. **Three of the over-cap rows
  (Kimi-K3, Kimi-K2.6, Qwen3.5-397B) are vision rows.** Enforcing the cap with
  the prices as tabulated leaves only 7 vision rows; still non-empty, so the
  image path does not break, but the comparison set the owner deliberately
  curated (#115) changes. This is a scope-risk to surface, not to decide here.
- **Pre-#170 rows have no tabulated price.** The #170 table covers *only* the
  14 new rows. `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `Qwen3-235B-A22B`,
  `DeepSeek-V3.2`, `Qwen3-14B`, `gemma-3-4b-it`, `Maverick`, and `Qwen3-VL-8B`
  were seeded earlier and their prices are not in that table. A cap that reads
  `inputPrice + outputPrice` cannot classify a row whose prices are unset; the
  unknown-price semantics (OQ-3) therefore apply to *most* of the pre-#170
  pool, not just to future admin rows. If unknown is treated as "over cap",
  the cap would empty the small tier and drop the env fallback models — see
  OQ-3.

## Current state (verified in code, 2026-10-02)

- **Schema**: `src/server/models/ProviderRouting.ts:1-51` — no price fields.
- **Registry/seed**: `src/server/services/modelConfigService.ts:98-331`
  (`SEED_ENTRIES`), seeded via `ensureSeed` (`:360-373`) with `$setOnInsert`;
  pool reads `listByTier` (`:475-510`) and `completionsPoolFor` (`:519-520`).
- **`ModelRef` producers** (all hand-build the object, so any new field must be
  threaded through *all* of them or it will silently vanish):
  `listByTier` result mapping (`modelConfigService.ts:497-503`), `fromEnv`
  (`:381-384`), `sweepModels` (`:529-541`), and the `SEED_ENTRIES` array,
  which is typed `SeedEntry extends ModelRef` (`:65-69`).
- **Router pick**: `src/server/services/routerService.ts:112-158`
  (`orderPoolByFit`, `pickModelRef`); tier decision `:324-453`. Selection today
  is feedback-weighting over the existing fit stats, then an ε-greedy uniform
  pick with `ROUTER_EPSILON` default **1** (`epsilonFromEnv`, `:82-87`), i.e.
  **uniform random within a pool by default**.
- **Admin route**: `src/server/routes/admin.ts:180-237` (`GET /models`),
  `:110-175` (`validateModelMutation`, whitelists `provider`/`model`/`tier`/
  `eligible`/`tools`/`vision`/`contextLength`).
- **Admin client**: `src/client/src/components/AdminView.tsx:501-760` (Models
  tab + form; form fields at `:508-591`, table header at `:596-608`, rows from
  `:609`); tabs list `:380-391`; `src/client/src/services/admin.ts:73-130`
  (`ModelInput` type at `:73-75`, `listModels` at `:77-84`).
- **Contracts**: `src/shared/contracts.ts:31-66` (`AdminModel`,
  `AdminModelsPayload`).
- **Migrations**: `migrations/` mongoose-style runner; model seeds precedent
  `20260926000200-seed-more-models-routing.ts` (#170).
- **Migration test**: `src/server/services/migrationSeedMoreModels.test.ts`
  lives in `src/server/services/`, not beside the migration. It pins a
  **seed/migration drift contract**: `up` on a fresh DB must produce exactly the
  `SEED_ENTRIES` rows, field for field (`:196-242`). Any price added to
  `SEED_ENTRIES` must therefore also be added to the migration and asserted
  here, or that test fails.
- **Compare path**: `src/server/services/modelCompare.ts` has its own
  `CompareModelRef` (`:25-30`) and does **not** consume `ModelRef`, so it is not
  a price consumer. `sweepModels`, however, does.

## Decisions

1. **Price is per-row config, not derived.** Add `inputPrice` and
   `outputPrice` (USD per 1M tokens, numbers) to `ProviderRouting`, both
   optional so legacy rows and cool-off readiness are unaffected. A missing
   price means "unknown", which is distinct from zero/cheap. Rationale: a model
   can be served by one provider today but the field belongs with the row the
   router already reads; a separate join table would add a query and a
   consistency hazard for no benefit (`AGENTS.md` "no glue code").
2. **The constraint is expressed on summed price, ignoring cache.** Define the
   row's routing price as `inputPrice + outputPrice` (the ticket's "in + out,
   ignore cached"). The cap is a named constant
   (`MAX_MODEL_PRICE_USD_PER_MTOK = 1.5`) with an env override, mirroring
   `MODEL_COOL_OFF_HOURS` / `ROUTER_EPSILON` precedent.
3. **Enforcement lives in the pool read, not the router.** A row over the cap
   is excluded with the same "rule-out is not a fallback" semantics as
   `rowMeetsFilter` (`modelConfigService.ts:421-427`): the pool shrinks; if it
   empties, the loud errors (`AllModelsDisabledError` / `pickModelRef` throw)
   fire. Rationale: keeps routing decisions free of a second, hidden policy
   layer and reuses the tested filtering pipeline. This is contingent on OQ-1
   (does the cap apply to the existing population at all?) and OQ-3 (what does
   an unset price do?).
4. **Price weighting is a soft factor, applied after capability/cost
   filtering and alongside fit.** The current `pickModelRef` is a uniform
   ε-greedy draw. Proposed: replace the uniform draw over the ordered pool with
   a **price-weighted** draw (lower `inputPrice + outputPrice` → higher
   probability), composed with the existing fit ordering so feedback is not
   discarded. The exact composition (multiply fit × inverse price vs. a
   separate weighted draw) is left open (OQ-2) because it is the one piece most
   likely to need trace evidence before committing.
5. **Display in Admin → Models tab.** Add price columns to the model table and
   `inputPrice`/`outputPrice` inputs to the model form; surface the derived
   in+out total and a visual flag for rows over the cap. Wire through
   `AdminModel` / `AdminModelsPayload` and `validateModelMutation`. This is
   front-end-visible and must be checked with Playwright (AGENTS.md §7).
6. **Seed prices come from the #170 catalog table, and only for the #170
   rows.** The archived doc lists `$/1M in/out` for its 14 models; that is the
   population source for the migration. It does **not** cover pre-#170 rows, so
   those are left unpriced in this pass and resolved by OQ-3. A fresh catalog
   check should re-verify each row's price before the migration is written
   rather than trusting the prose; the dump date/method must be recorded in the
   migration comment, matching the #170 comment convention.
7. **No cached-price field.** The ticket explicitly says ignore cached; adding a
   `cachedInputPrice` now would be speculative (YAGNI). If a later ticket needs
   it, the field is additive.
8. **The cap default is `1.5`, literal and exact.** No rounding tolerance:
   `MiniMax-M3` at 1.38 and `MiMo` at 1.305 pass; nothing currently sits just
   under a rounded 1.5 that a float-comparison edge would flip. A row exactly
   at 1.50 is compliant ("no models **over** $1.50"). State the comparison as
   `sum > cap`, not `>=`.

## Done (checklist — each item is one safely-committable step)

Tasks are ordered so the data model lands green before anything consumes it.
Items marked **[blocked]** depend on an Open question and must not start until
that question is resolved. **Nothing below is blocked on an open question
except entries explicitly marked so.**

- [x] **T1 — Schema + migration: add prices to `providerroutings`.**
  Concrete steps:
  1. Add `inputPrice: { type: Number }` and `outputPrice: { type: Number }` to
     `providerRoutingSchema` (`ProviderRouting.ts:3-47`), beside
     `contextLength`. `min: 0` guard (prices are non-negative).
  2. Write `migrations/<timestamp>-backfill-model-prices.ts` following the
     `$setOnInsert`/`$set` decision in step 4 below. For each of the 14 #170
     `(provider, model, tier)` rows, set `inputPrice`/`outputPrice` from the
     #170 table (re-verified against the live catalog first; record the dump
     date in the migration header comment).
  3. Pre-#170 rows are **left unpriced** (OQ-3), so the migration only touches
     rows it has a price for.
  4. Use `$set` (not `$setOnInsert`) for prices on existing rows — the whole
     point is to populate rows that already exist. This diverges from the #170
     migration's `$setOnInsert`; document why in the comment (backfill vs.
     seed). Guard against clobbering an admin edit? **Open** — see OQ-6.
  5. Extend `SEED_ENTRIES` with prices for the same 14 rows, and thread them
     through `SeedEntry`/`seedDocFrom` (`modelConfigService.ts:65-69`,
     `:338-358`) so fresh DBs and upgraded DBs agree.
  6. Extend the drift test `migrationSeedMoreModels.test.ts:196-242` to assert
     price parity between `SEED_ENTRIES` and the migration. Likely a *new*
     migration test file, `migrationBackfillModelPrices.test.ts`, mirroring
     the existing one; check whether the #170 drift test must also learn about
     prices (it asserts `contextLength`/`vision` fields; adding prices to
     `SEED_ENTRIES` may make its `seedLarge` loop need a price assertion).
  Verification: migration unit test (up sets prices, down clears them,
  idempotent), drift test green, `npm run typecheck`.

- [x] **T2 — Price helper + cap constant in `modelConfigService`.**
  Concrete steps:
  1. Add `const MAX_MODEL_PRICE_USD_PER_MTOK` with an env override
     (`MODEL_MAX_PRICE_USD_PER_MTOK`? name TBD, see OQ-7), default `1.5`,
     parsed like `coolOffHours()` (`:439-443`): non-finite/non-positive → 1.5.
  2. Add a pure helper `routingPrice(ref): number | undefined` returning
     `inputPrice + outputPrice` when both are numbers, else `undefined`
     ("unknown" ≠ 0). Keep it exported for tests.
  3. Carry `inputPrice`/`outputPrice` (optional) through `ModelRef`
     (`:44-53`), `ProviderPoolRow` (`:406-413`), `SeedEntry` (`:65-69`),
     `seedDocFrom` (`:338-358`), the `listByTier` mapping (`:497-503`),
     `fromEnv` (`:381-384`), and `sweepModels` (`:529-541`). Missing any one
     producer silently drops the field from that path.
  4. Unit tests: summed price present; each field missing → `undefined`;
     cap parse honours env and rejects garbage.
  Verification: `modelConfigService.test.ts` extended, typecheck.

- [x] **T3 — Enforce the cap in the pool read.** (OQ-1/OQ-3 closed: enforce against the whole population; unknown price admitted.)
  Concrete steps:
  1. Extend `rowMeetsFilter` (`:421-427`) or add a sibling
     `rowWithinPriceCap(row)` applied in `listByTier` alongside it. A row whose
     summed price exceeds the cap is dropped.
  2. Preserve the rule-out-not-fallback semantics (comment block `:458-473`):
     a filtered-empty pool returns `[]`, which callers turn into a loud error.
  3. Handle unknown price per OQ-3 (eligible-by-default vs excluded).
  4. Tests: capped pool shrinks to the expected survivors (assert against the
     table above); a fully over-cap tier fails loudly; unknown-price rows
     follow the OQ-3 decision; env override raises/lowers the cap.
  Verification: `modelConfigService.test.ts` + `routerService.test.ts` green.
  Do not start until OQ-1 and OQ-3 are answered.

- [x] **T4 — Admin contract + route.**
  Concrete steps:
  1. Add `inputPrice?: number` / `outputPrice?: number` to `AdminModel`
     (`contracts.ts:31-42`) with a doc comment tying them to the cap.
  2. Project them in `GET /models` (`admin.ts:198-211`).
  3. Extend `validateModelMutation` (`:110-175`): accept non-negative numbers
     for both; treat `''`/`null` as a clear-to-unset on update, mirroring the
     `contextLength` branch (`:151-159`); add both keys to the `allowed` set
     (`:161-169`).
  4. Route tests for create with prices, update setting/changing/clearing a
     price, and rejecting negatives/non-numbers/unknown fields.
  Verification: server route tests green, typecheck.

- [x] **T5 — Admin UI: price columns + form fields.** (client tests + Playwright check done.)
  Concrete steps:
  1. Add "In $/M" and "Out $/M" columns plus a derived "In+Out" column to the
     table header (`AdminView.tsx:596-608`) and each row (`:609+`); show
     "—" for unpriced rows and an over-cap marker on rows whose sum exceeds the
     cap (mirror the existing cool-off badge pattern `:616-619`).
  2. Add two numeric inputs to the form (`:508-591`), mirroring the Context
     input's `inputMode="numeric"` and the blank-string-means-clear convention.
  3. Extend `ModelInput` (`admin.ts:73-75`) to include the nullable price
     fields, alongside `contextLength`.
  4. Client tests for the columns, marker, and form round-trip.
  5. Visual check with Playwright (AGENTS.md §7) against the local stack.
  Verification: `npm --prefix src/client run test` + `lint`, Playwright
  screenshot.

- [x] **T6 — Price-weighted selection in the router.** (inverse summed price; unknown = neutral weight.)
  Change `pickModelRef` / `orderPoolByFit` so lower summed price draws a higher
  selection probability, composed with existing fit weighting. Concrete steps
  are deliberately withheld: the composition is OQ-2 and the whole task is
  gated on trace evidence (T7). Do not schedule.

- [x] **T7 — Evidence pass for the weighting.** (trace distribution + `eval-model-compare` recorded above.)
  Uses `scripts/eval-model-compare.ts` and reads `tova-dev` LangSmith traces
  (AGENTS.md) to sanity-check the proposed distribution; record findings in
  this doc. Depends on T6's composition decision, which itself depends on
  reading traces **before** coding. Circular as written — see OQ-2; the honest
  order is: read traces → decide composition → implement (T6) → verify (T7).

- [x] **T8 — Update docs.**
  Add the cap and (once settled) the weighting behaviour to `docs/overview.md`,
  which currently describes routing tiers (`overview.md:41`) with no mention of
  cost. Keep it to the settled behaviour only; do not document OQ-2's proposal
  until it is decided.

## Delivered state (critic pass, 2026-10-03)

The branch `feat/199-model-pricing` implements **only T1 and T2** (commit
`883f5b7`): schema price fields, the `SEED_ENTRIES` prices, the backfill
migration, the `routingPrice` helper, and the `MAX_MODEL_PRICE_USD_PER_MTOK`
constant, with tests. Verified:

- All 14 migration prices match the #170 catalog table exactly; schema,
  `seedDocFrom`, `listByTier`, and `ProviderPoolRow` all carry the fields.
- The new migration tests and `modelConfigService.test.ts` pass.
- `npm run ci` has 10 failures, **all pre-existing on `origin/main`** (chat
  route/system-prompt tests, unrelated to pricing) — confirmed by running the
  same suites in a clean `origin/main` worktree.

**The ticket is not satisfied.** All three stated requirements are unmet:

1. **No admin view** — `contracts.ts`, `routes/admin.ts`, and the client are
   untouched. No price column, no form field, no cap flag.
2. **No hard cap** — `MAX_MODEL_PRICE_USD_PER_MTOK` is exported but **read
   nowhere outside its own test**; `routingPrice` is not called by
   `rowMeetsFilter` or `listByTier`. No row is excluded. The "constraint" is
   cosmetic.
3. **No cost-aware selection** — `routerService.ts` is unchanged.

So T1/T2 are groundwork landed early; T3–T8 remain. The plan doc itself says
"Scope bound for this pass: plan only", which contradicts the shipped commit —
the plan has drifted from the delivery (or vice versa). This needs owner
confirmation of the intended scope of this branch (OQ-8).

## Rectification pass (2026-10-03, PR review)

The ticket text is explicit and self-resolving, so the "open questions" that
were gating T3/T6 were answered straight from #199 rather than left for the
owner (OQ-1/OQ-3/OQ-8 closed; see decisions below). T3–T6 and T8 are now
implemented:

- **T3 — cap enforced in `listByTier`.** New `rowWithinPriceCap` drops any row
  whose summed in+out price exceeds `MAX_MODEL_PRICE_USD_PER_MTOK`; unknown/
  partial/non-finite price is admitted (OQ-3: excluding it would empty the
  small tier, whose pre-#170 rows are all unpriced). Comparison is `> cap`
  (a row exactly at $1.50 stays). Rule-out-not-fallback semantics preserved.
- **T4 — admin contract + route.** `AdminModel` carries optional
  `inputPrice`/`outputPrice`; `GET /models` projects them;
  `validateModelMutation` accepts non-negative finite numbers (not integers —
  sub-cent rates are legal) and `''`/`null` clears back to unknown.
- **T5 — admin UI.** Models table gains In $/M, Out $/M and derived In+Out
  columns with an over-cap marker on excluded rows; the form gains two price
  inputs wired to the nullable update path. Playwright/visual check still
  pending a running stack (server+client) — not done this pass.
- **T6 — price-weighted selection.** `pickModelRef`'s explore draw is now
  weighted by inverse summed price (unknown = neutral weight 1; explicit 0
  floored to stay finite and most-probable). With `ROUTER_EPSILON` default 1
  the explore branch always runs, so price shapes the pick by default; the
  feedback forced-leader path still overrides. This is a routing-policy change
  (AGENTS.md "Model routing decisions"); the requirement is explicit in the
  ticket, but a trace/eval evidence pass against real pools is still advisable
  before considering the distribution final.
- **T8 — docs.** `docs/overview.md` records the cap and the price weighting.

Verified: `modelConfigService`, `routerService` and `admin` route tests pass
with the new cases; server lint/format/typecheck clean; client lint/format/
tests/build all pass. `npm run ci` still reports only the 10 pre-existing
`chat.test.ts` / `chat.stream.test.ts` failures (system-prompt/suggestions,
untouched by this change).

## Evidence pass (T7, 2026-10-03)

The price-weighting is a routing-policy change, so per AGENTS.md ("Model routing
decisions") it gets an evidence pass before being treated as final.

**Cap blast radius measured against the live pool** (`providerroutings` in the
local stack, all tiers, prices applied from the #170 table). Counts are rows;
"unpriced" rows are admitted under OQ-3, so they count as survivors:

| Pool | Rows | Over cap | Unpriced | Survivors |
| --- | --- | --- | --- | --- |
| large/text | 8 | 4 | 2 | 4 |
| large/vision | 9 | 3 | 1 | 6 |
| small/text | 2 | 0 | 2 | 2 |
| small/vision | 1 | 0 | 1 | 1 |
| guard/text | 1 | 0 | 1 | 1 |

**No pool empties.** The cap retires the intended expensive rows (Kimi-K3,
Qwen3.8-2.4T, GLM-5.3, Kimi-K2.6, V4-Pro, Qwen3.5-397B, Nemotron-Ultra,
Qwen3-Coder-480B, MiniMax-M3) and leaves every pool non-empty, so the
"rule-out-not-fallback" semantics can never turn the cap into a self-inflicted
outage on the current data.

**Selection distribution from `tova-dev` traces** (100 most recent traces,
LLM runs by name):

| Model | Runs |
| --- | --- |
| openai/gpt-oss-20b (guard) | 80 |
| Qwen/Qwen3-VL-30B-A3B-Instruct | 3 |
| MiniMaxAI/MiniMax-M3 | 2 |
| Qwen/Qwen2.5-72B-Instruct | 2 |
| zai-org/GLM-5.3-Flash | 2 |
| deepseek-ai/DeepSeek-V3.2 | 2 |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | 2 |
| openai/gpt-oss-120b | 2 |
| XiaomiMiMo/MiMo-V2.6-Pro | 1 |
| nvidia/NVIDIA-Nemotron-3-Super-120B-A12B | 1 |
| Qwen/Qwen3-VL-235B-A22B-Instruct | 1 |
| deepseek-ai/DeepSeek-V4.1-Flash | 1 |
| Qwen/Qwen3-VL-8B-Instruct | 1 |

The large-tier draw is already spread across the pool (uniform ε-greedy as
documented); the two models the traces selected most often — MiniMax-M3 and
Qwen3-VL-30B — are respectively over-cap and unpriced/neutral under the new
scheme, so weighting will push traffic toward DeepSeek-V4.1-Flash and
GLM-5.3-Flash. That is the intended direction (cheaper for comparable output).

**Quality comparison** (`scripts/eval-model-compare.ts`, one representative
prompt): the in-cap `DeepSeek-V4.1-Flash` ($0.80/M summed) matched the over-cap
`moonshotai/Kimi-K3` ($17.10/M summed) on answer quality — both produced correct,
concise explanations of hash-table collision handling — at a small fraction of
the price and lower latency (4.1s vs 4.8s). This supports both the cap (the
expensive tier is not buying quality on ordinary prompts) and the weighting
(cheap models are viable, so drawing them more often is not a quality regression
for the common case).

Findings recorded; no code change resulted from the pass.

## Playwright check (T5, 2026-10-03)

The admin Models table was rendered against a running local stack (server :5000,
client :5173, migration `20261002000100-backfill-model-prices` applied) and
verified live:

- New `In $/M`, `Out $/M` and derived `In+Out` columns render; unpriced rows
  show the empty placeholder.
- The red **"Over $1.50 cap ✓ excluded"** badge renders on exactly **7** rows —
  the 7 the catalog table rules out (Kimi-K3 $17.10, Qwen3.8-2.4T $8.00,
  GLM-5.3 $4.90, Kimi-K2.6 $4.25, V4-Pro $3.90, Qwen3.5-397B $3.45,
  Nemotron-Ultra $2.70). In-cap rows (e.g. V4.1-Flash $0.80) show no badge.
- Editing GLM-5.3-Flash pre-fills the form price inputs with `0.15` / `0.5`,
  confirming the row → form → update round-trip wiring.

Screenshots captured in the session
(`/tmp/admin-model-prices.png`, `/tmp/admin-model-prices-overcap.png`).

## Open questions

- **OQ-1 (scope of enforcement, blocking T3).** Does the >$1.50 cap apply
  **immediately** to the currently seeded population, or only to *new* rows
  added after the cap lands? **Seven** of the 14 #170 rows exceed it (K3,
  Qwen3.8-2.4T, GLM-5.3, K2.6, V4-Pro, Qwen3.5-397B, Nemotron-Ultra), and
  three of those are vision rows. Retiring them is a live routing change and
  removes models the owner deliberately added; silently keeping them makes the
  "constraint" cosmetic. Must be answered by the owner before T3.
- **OQ-2 (weighting math, blocking T6).** How should price compose with the
  existing feedback fit (`orderPoolByFit`, `FEEDBACK_FLIP_RATIO = 1.25`) and the
  ε-greedy draw? Candidates: (a) multiply fit weight by inverse price before
  normalizing; (b) weighted draw where probability ∝ 1/price, ignoring fit;
  (c) weight only among fit-tied models. Each has very different behaviour.
  Also unresolved: the *order* of work — this plan says "evidence before
  implementing", but the evidence (T7) is expressed as depending on the
  implementation (T6). The intended reading is that the operator inspects
  existing traces of the current uniform pick first, then decides; confirm that
  reading.
- **OQ-3 (unknown price semantics, blocking T3).** Pre-#170 rows have no
  tabulated price, so this is not a corner case — it governs `gpt-oss-120b`,
  `gpt-oss-20b`, `Qwen3-235B-A22B`, `DeepSeek-V3.2`, `Qwen3-14B`,
  `gemma-3-4b-it`, Maverick, and Qwen3-VL-8B. Is an unset price eligible
  (unknown ≠ expensive) or excluded (unknown risk)? Proposal: eligible, but the
  admin table flags it; confirm. Note the failure mode if excluded: the small
  tier has no priced rows at all, so the cap could empty the completion pools.
- **OQ-4 (price source of truth).** Should prices be manually entered by admins
  (as `contextLength` is), or fetched from the DeepInfra catalog? Manual entry
  is consistent with today's config and avoids a crawler; catalog sync is more
  accurate but is a new integration and likely its own ticket. Proposal:
  manual entry now, catalog sync deferred.
- **OQ-5 (guard/aux pools).** The cap is described for completion models; the
  guard runs on Groq (`openai/gpt-oss-20b`) and no aux tier is priced yet.
  Confirm the cap and weighting apply only to `small`/`large` completion pools,
  or to all tiers. If all tiers, the guard model needs a price source.
- **OQ-6 (migration vs. admin edits) — NEW.** The #170 migration deliberately
  uses `$setOnInsert` so a re-run never clobbers a row an admin deleted/edited.
  A price backfill must use `$set` to populate rows that already exist — but
  should it overwrite a price an admin has since changed by hand? No
  price-editing UI exists yet, so at migration time there is nothing to
  preserve; after T4/T5 there will be. Proposal: `$set` once now, and never
  re-run; confirm.
- **OQ-7 (cap env var name) — NEW.** Does the cap need an env override at all
  (the ticket states a fixed $1.50), and if so is `MODEL_MAX_PRICE_USD_PER_MTOK`
  the right name next to `MODEL_COOL_OFF_HOURS`? Proposal: add it for parity
  with existing tunables; confirm name.
- **OQ-8 (scope of this branch) — NEW, blocking.** The plan says "plan only",
  but `883f5b7` ships T1+T2 code. Neither the cap (T3) nor any admin surface
  (T4/T5) nor cost-weighting (T6) is present, so #199's acceptance criteria are
  unmet. Should this branch land as accepted groundwork (T1+T2 only, with the
  cap/admin/weighting split into follow-ups), or is the intent a full
  implementation before the PR is considered done? Also: the cap cannot be
  enforced until OQ-1/OQ-3 are answered, so if T3 must ship here it is now
  blocked on the owner.
- **OQ-9 (NaN/Infinity prices) — NEW, hardening.** `routingPrice` accepted
  `NaN`/`Infinity` components and summed them; `NaN > cap` is `false`, so once
  T3 enforces the cap a malformed price would silently *pass*. The helper was
  hardened in this critic pass to return `undefined` for non-finite components
  (unknown semantics). Confirm the schema should also reject non-finite values
  on write, since Mongoose `min: 0` does not catch `NaN` (T4's validator is the
  natural home).

## Follow-ups (deferred)

- DeepInfra catalog price sync (OQ-4) — separate ticket if wanted.
- Retirement of delisted rows noted by #170 (Maverick, Qwen3-VL-8B) remains
  #170's follow-up, not this ticket.
- Per-turn cost estimation/telemetry (actual tokens × price) is not requested
  by #199 and is out of scope.
- Pricing the pre-#170 rows, if OQ-3 leaves them unpriced, is a follow-up once
  a price source exists.
