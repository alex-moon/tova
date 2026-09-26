# Plan: More models (DeepInfra expansion, ZDR-only)

Ticket: alex-moon/tova#170 — "More models"
Branch: `feat/170-more-models`
Written: 2026-09-26, plan-write pass. Revised: 2026-09-26, plan-review pass
(this document). No code changes yet — the two passes researched the catalog,
probed candidates, fixed the selection, and re-verified every factual claim.
Sources are named inline; facts re-verified in the review pass are marked **[R]**.

## Status (revision 4, 2026-09-26 — critic pass; working tree, uncommitted)

Independent adversarial review of the branch (diff vs `origin/main`).
The orchestrator owns commit/push.

Re-verified first-hand this pass:
- Live catalog re-dump (`GET /v1/openai/models`, 2026-09-26): all 14 ids
  present, 187 models / 102 chat-tagged; every `contextLength`, input/output
  price and vision tag still matches the decision-1 table exactly, and the
  Maverick/VL-8B delisting is re-confirmed (both absent from the dump).
- Live probes re-run: `XiaomiMiMo/MiMo-V2.6-Pro` and `MiniMaxAI/MiniMax-M3`
  clean 200s with tools + `image_url` part; `NVIDIA-Nemotron-3-Super-120B-A12B`
  "Model busy" 429 on 2/2 attempts — OQ-2's recurrence holds (evidence
  updated there).
- Local DB inspection: all 14 rows present field-complete post-migration;
  admin deletions (Maverick, gpt-oss-120b-large, VL-8B-large) were not
  resurrected. Side observation, not #170's scope: the local dev DB carries
  stale pre-migration rows production-shaped DBs would not have
  (`Qwen/Qwen2.5-72B-Instruct` small tier with `contextLength: null`;
  VL-8B at small tier) — they share local small-tier traffic until cleaned.

Hardening added this pass (uncommitted, on top of the deliverable):
- `migrationSeedMoreModels.test.ts` gained a seed↔migration drift test:
  `up` on a fresh (empty) DB must insert exactly the 14 rows, every field
  present-on-insert, and the row set must equal the non-pre-#170 large
  `SEED_ENTRIES` rows (cross-checked via `sweepModels`) field for field.
  Closes the two-copies-of-the-same-truth hole: nothing previously related
  SEED_ENTRIES to the migration `ROWS`, so a one-sided future edit would
  silently split fresh DBs from upgraded ones. Mutation-verified (a
  one-field drift injected into the migration fails the test; reverted).
  Also covers the previously untested fresh-deployment `up` path
  (migrations run before the app ever seeds).
- `npm run ci` exit 0 with the added test: 69 suites / 886 tests green.

The four open questions are (re-)queued on the ticket this pass — the
injected ticket state still shows no comments, so per the plan-169
precedent the substance is re-queued regardless of what earlier passes
may have queued. OQ-2 carries today's added recurrence evidence.

### Status (revision 3, 2026-09-26 — implementation pass; archived below)

Implemented tasks 1–3. The orchestrator owns commit/push.

- Task 1 DONE: 14 rows inserted into `SEED_ENTRIES` between the Maverick and
  guard entries (one `#170` comment: ZDR grounding, probe evidence, the
  Nemotron-3-Super capacity note, the delisting discovery). Seed tests
  updated: large-tier `arrayContaining` extended with all 14 read-back
  shapes, the three `countDocuments` assertions moved 10 → 24, the vision
  pool exact equality rewritten to the 10-row sorted set — the derived
  binary-collation order (`MiniMaxAI` < `Qwen/...-` < `Qwen3.5` < `Xiaomi`
  < `deepseek` < `moonshotai` < `zai-org`) confirmed by a green test run.
- Task 2 DONE: `migrations/20260926000200-seed-more-models-routing.ts`
  (class `SeedMoreModelsRouting`, `ROWS` loop of `$setOnInsert` upserts,
  every row `disabledUntil: null`, text rows explicit `vision: false`,
  `down` = `deleteOne` loop) + `migrationSeedMoreModels.test.ts` (10-row
  deployed fixture → up 24 with field-complete rows → idempotent →
  no-clobber of a pre-inserted `eligible: false` admin deletion → down
  restores the 10 fixture rows). Full server suite: 69 suites / 885 tests
  green.
- Task 3 DONE: probes re-run at implementation time (see below), local
  `npm run db:migrate` applied cleanly over the deployed 7-row shape
  (legacy rows untouched, 14 new rows field-complete on inspection),
  `docs/progress.md` entry added, plan mirrored to `docs/`.
- Implementation-pass probes (2026-09-26): catalog re-dumped — 187
  models / 102 chat-tagged, all 14 ids present, every contextLength,
  price and vision tag matching the table. Live: 13/14 clean 200s with
  tools (+ image part for the 8 vision rows).
  `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` returned "Model busy" 429 on
  ALL 6 attempts this pass (~20 min apart) — worse than the review pass's
  2-of-3, but still capacity (not delisted, not tool-incapable), so the
  row stays per the decisions and OQ-2 is re-queued with this evidence.
- `npm run ci` exit 0.

### Status (revision 2, 2026-09-26 — plan-review pass; archived below)

Independent re-verification of the plan-write claims, corrections, and task
detail. The orchestrator owns commit/push.

Re-verified first-hand **[R]**:
- Fresh catalog dump (`GET https://api.deepinfra.com/v1/openai/models`): 187
  models, 102 chat-tagged — identical counts to plan-write. All 14 selected ids
  present; every `contextLength`, input/output price, and vision tag in the
  table below matches the dump exactly.
- ZDR rule re-read off `docs.deepinfra.com/account/data-privacy` (via search):
  input/output not stored, no training, no third-party sharing — exceptions are
  exactly Google models and Anthropic models. The only other retention exception
  (image-generation outputs, briefly, for demo pages) is irrelevant: we seed
  chat completions only.
- Live probes re-run (OpenAI-style `tools` request; `image_url` part added in
  the same request for the 8 vision rows): 13/14 returned 200.
  `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` returned 429 "Model busy" on 2 of
  3 attempts ~10 minutes apart, then a clean 200 — the plan-write "one
  transient 429" understated recurrence; see OQ-2.
- The two delisted seed rows still serve traffic via legacy aliases (both 200
  on a direct probe today) — OQ-1 is real but NOT urgent.
- DeepInfra's own docs (Claude Code integration page) recommend `moonshotai/Kimi-K3`
  ("Strongest open-weights agentic coder … priciest of the set by a wide
  margin") and `deepseek-ai/DeepSeek-V4-Pro-0813` — corroborating "newer,
  popular and featured" for two selections, and the cost caveat for one.

Corrections made this pass (folded into the sections below):
- Kimi-K3's output price is ~16–24x today's pool maximum (the plan-write draft
  said "~5x" — wrong under any reading of the current pool's prices).
- GLM-5.3-Flash's price advantage over GLM-5.2 is ~1/5 by catalog rates
  ($0.15/$0.50 vs $0.75/$2.40), not "~1/10" — vendor marketing number dropped.
- The seed test has THREE `countDocuments() === 10` assertions
  (modelConfigService.test.ts lines 86, 108, 418), not one — all three move
  to 24 in task 1.
- Migration rows must carry `disabledUntil: null` explicitly and `vision: false`
  on text rows: migrations write through the raw driver and bypass mongoose
  schema defaults (`ProviderRouting` has no `disabledUntil` default, and the
  #168 seed convention is "field present-on-insert"). The Qwen3Vl migration
  precedent predates #168 and must not be copied blindly on these two fields.
- The ticket's "parameters" is applied as TOTAL params (the convention the
  model ids themselves encode, e.g. `Qwen3-235B-A22B`); now stated explicitly
  as decision 1b. Active params are shown for information only.
- The exclusions list was incomplete: 14 more catalog rows are now accounted
  for with reasons (see decision 2: Qwen3-Max-Thinking, Qwen3.8-Flash,
  MiMo-V2.6-Flash, Nemotron-3.5-Lightning, Nemotron-Content-Safety-3.5,
  gpt-oss-120b-Turbo/Ultra, Llama-4-Scout, Hermes-3-Llama-3.1-70B,
  Sao10K/Euryale-70B, DeepSeek-V3/V3.1/R1-0528, GLM-4.6).
- Side effect now on record: `sweepModels` (the #158 eval sweep universe,
  consumed by `scripts/run-evals.ts`) grows 9 → 23 eligible rows; full sweeps
  become proportionally more expensive.
- The ticket body itself answers OQ-2's size half: 70–170b models are the
  "small" bucket — acceptable, just less valuable than >170b; only <70b is
  ignored. The remaining doubt about the 70–170b representative is capacity,
  not size (OQ-2 rewritten around the 429 recurrence).
- Removed the stray `{}` at the end of the file (a plan-write verdict artifact,
  not plan content).
- All four open questions were (re-)queued on the ticket this pass, following
  the plan-169 precedent: queue state is unobservable from inside a pass, so
  substance is re-queued even if the plan-write pass already queued some of it.

## Motivation

Alex is deleting unfit models in the Models admin as they prove themselves on real traffic — a
process of elimination. [#170](https://github.com/alex-moon/tova/issues/170) asks for more
candidates from DeepInfra so the pool has something to eliminate *toward*: ZDR is non-negotiable
(no partner models), newer/popular/featured models preferred, and big models first
(>170b most valuable, 70–170b acceptable, <70b ignored).

Today the completion pools live in `SEED_ENTRIES`
(`src/server/services/modelConfigService.ts:80-177`): small tier = gpt-oss-20b + Qwen3-14B
(plus the vetoed gemma row), large tier = 6 models, guard = Groq gpt-oss-20b. Both completion
tiers pin DeepInfra in code (#94/#117: `TIER_PROVIDER` maps both to `deepinfra` and
`completionsPoolFor` filters `provider: 'deepinfra'`), so every addition is a DeepInfra model
by construction.

## Grounding (gathered across plan-write + review passes)

- **ZDR / "partner models" pinned.** Per <https://docs.deepinfra.com/account/data-privacy>:
  DeepInfra does not store input/output to disk, does not train on, and does not
  share API data — **except Google and Anthropic models**, where data is transferred to
  those partners, stored by them, and subject to their training policies. **[R]** Re-read
  this pass; text confirmed. So the ZDR rule excludes exactly `google/*` and `anthropic/*`
  on DeepInfra (21 chat rows in the current dump). Everything selected below is a
  DeepInfra-hosted zero-retention model; by the same privacy page, all non-partner models
  are served on DeepInfra's own infrastructure (open-weight serving), so every selection
  is open-weight.
- **Catalog snapshot 2026-09-26** via `GET https://api.deepinfra.com/v1/openai/models`
  (key in `.env`): 187 models, 102 tagged `chat`. **[R]** Re-dumped this pass; identical
  counts, all 14 ids/contexts/prices/tags match. All context lengths and prices in the
  table come from this dump; model ids are copied verbatim from it.
- **Live probes 2026-09-26** (one-off scripts, not committed): every candidate below accepted an
  OpenAI-style `tools` request (function calling works — the completion pool pins
  `tools: true`); every `vision: true` row accepted an `image_url` part in the *same* request as
  tools (the probe convention #115 set for vision rows). **[R]** Re-run this pass: 13/14 clean
  200s on first attempt; `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` 429'd twice (see
  Assumptions/OQ-2), then 200 on retry. Runtime endpoint failures are covered by #168
  cool-off (6h default) — one failed turn re-routes via failover, not a user-visible error.
- **Featured status** was cross-checked at plan-write against deepinfra.com (homepage
  "Explore our Featured Models", `/deepstart`, logged-in rail) via web search. Not
  re-verified per-model in the review pass — it is a preference tiebreaker, not
  load-bearing: the selection stands on catalog presence, probes, and the size/price/newness
  rules either way.
- **Discovery, out of scope (OQ-1):** DeepInfra has **delisted** two current seed entries:
  `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` and `Qwen/Qwen3-VL-8B-Instruct` are no
  longer in the catalog. **[R]** Confirmed absent from this pass's dump; both still answer
  direct probes (legacy aliases). #170 says "add"; retiring those rows is suggested as a
  follow-up ticket, not done here.

## Decisions

1. **Selection = 14 models, all `provider: 'deepinfra'`, all `tier: 'large'`, all
   `eligible: true`, all `tools: true`.** Rationale for `large`: the ticket's
   "<70b ignored" rule forbids new small-tier rows outright, and the 70–170b
   bucket's one representative belongs where gpt-oss-120b (120b total) already
   lives — the large tier.

   | Model (exact catalog id) | Params (total/active) | ctx | vision | $/1M in/out | Why this one |
   |---|---|---|---|---|---|
   | `deepseek-ai/DeepSeek-V4-Pro-0813` | 1.6T / 49B | 1048576 | no | 1.30 / 2.60 | newest official V4-Pro; homepage-featured; DeepInfra's own docs recommend it for agentic work **[R]** |
   | `deepseek-ai/DeepSeek-V4.1-Flash` | 284B-class / 13B | 1048576 | **yes** | 0.20 / 0.60 | newest Flash refresh; featured; cheap big workhorse |
   | `moonshotai/Kimi-K3` | 2.8T / 104B | 1048576 | **yes** | 2.85 / 14.25 | newest Kimi flagship (Jul 2026); featured; DeepInfra's own top agentic-coder pick — and its own docs flag it "priciest … by a wide margin" (see Assumptions, OQ-4) |
   | `moonshotai/Kimi-K2.6` | 1T / 32B | 262144 | **yes** | 0.75 / 3.50 | homepage-featured; the cheaper Kimi to compare against K3 |
   | `Qwen/Qwen3.8-2.4T-A95B` | 2.4T / 95B | 262144 | no | 2.00 / 6.00 | newest open Qwen flagship; featured |
   | `Qwen/Qwen3.5-397B-A17B` | 397B / 17B | 262144 | **yes** | 0.45 / 3.00 | big vision row with `reasoning_effort` |
   | `Qwen/Qwen3-VL-235B-A22B-Instruct` | 235B / 22B | 262144 | **yes** | 0.20 / 0.88 | VL flagship; the delisted VL-8B alias is served from this backend anyway |
   | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` | 480B / 35B | 262144 | no | 0.30 / 1.00 | large, cheap coding strength (OQ-3 flags the specialist risk) |
   | `zai-org/GLM-5.3` | 744B / 39B | 1048576 | no | 0.90 / 4.00 | newest GLM (Aug 2026) |
   | `zai-org/GLM-5.3-Flash` | 320B / 18B | 1048576 | **yes** | 0.15 / 0.50 | released Aug 2026; featured; ~1/5 of GLM-5.2's price at catalog rates |
   | `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | 550B / 55B | 262144 | no | 0.50 / 2.20 | frontier-reasoning flagship of the new Nemotron 3 line |
   | `XiaomiMiMo/MiMo-V2.6-Pro` | 1.02T / 42B | 1048576 | **yes** | 0.435 / 0.87 | featured; omnimodal (vendor claim); cheap for its size |
   | `MiniMaxAI/MiniMax-M3` | 428B / 23B | 524288 | **yes** | 0.28 / 1.10 | newest MiniMax (Jun 2026) |
   | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 120B / 12B | 262144 | no | 0.085 / 0.40 | the single 70–170b bucket representative (OQ-2: capacity doubt) |

   1b. **Size basis: total parameters.** The ticket's ">170b / 70–170b / <70b"
   buckets are read against TOTAL parameters — the convention the model ids
   themselves encode (`Qwen3-235B-A22B`, `Nemotron-3-Ultra-550B-A55B`) and the
   convention the current pool already uses informally (Qwen3-235B-A22B is a
   large-tier row). Active params are listed for information. Under an
   active-params reading almost nothing (including existing pool rows) would
   qualify as ">170b", which cannot be the ticket's intent. 13 of the 14
   selections are >170b total; the exception is the deliberate 70–170b
   representative.

   Sources for params: catalog ids (Nemotron/Qwen sizes are in the id); DeepInfra `/deepstart`
   copy for Qwen3.8-2.4T-A95B and MiMo-V2.6-Pro; vendor/model-card pages for the rest
   (Kimi-K3 2.8T/104B, Kimi-K2.6 1T/32B, GLM-5.3 ~744B/39B, GLM-5.3-Flash 320B/18B,
   DeepSeek-V4-Pro 1.6T/49B, V4-Flash 284B/13B, MiniMax-M3 428B/23B).

2. **Excluded, with reasons** (so the next pass doesn't re-litigate):
   - `google/*` (gemini, gemma) and `anthropic/*` (claude): ZDR exceptions — partner models.
   - `Qwen/Qwen3-Max`, `Qwen3-Max-Thinking`, `Qwen3.7-Max`, `Qwen3.8-Max`: closed
     flagships, params undisclosed; `Qwen3.8-2.4T-A95B` is the open-weight variant
     of Qwen3.8 Max at comparable price.
   - Superseded by a selected newer model (or 2024-era — "prefer newer" loses):
     `zai-org/GLM-5.2`, `GLM-4.6`, `GLM-4.7`, `MiniMaxAI/MiniMax-M2.7-Turbo`,
     `deepseek-ai/DeepSeek-V4-Flash` and `V4-Flash-0731`, `deepseek-ai/DeepSeek-V3`,
     `V3.1`, `R1-0528` (V3.2 already seeded; V4 line selected),
     `Qwen/Qwen3-Next-80B-A3B-Instruct`, `Llama-3.3-70B` / `Meta-Llama-3.1-70B`,
     `NousResearch/Hermes-3-Llama-3.1-405B` and `Hermes-3-Llama-3.1-70B`,
     `Sao10K/L3.1-70B-Euryale-v2.2` (2024-era roleplay finetune),
     `Qwen/Qwen2.5-72B-Instruct`.
   - `meta-llama/Llama-4-Scout-17B-16E-Instruct`: 17B active (~109B total);
     the Maverick family's small sibling, April-2025-era — under the
     total-params reading it is only a 70–170b candidate and loses on "prefer
     newer" to Nemotron-3-Super; under an active reading it is <70b outright.
   - Params undisclosed / variant branding — excluded on verifiability grounds
     rather than seeded speculatively: `Qwen/Qwen3.8-Flash` (Flash sibling of
     Qwen3.8-27B; 1000000 ctx, $0.113/$0.382), `XiaomiMiMo/MiMo-V2.6-Flash`
     (small sibling of the selected Pro), `nvidia/NVIDIA-Nemotron-3.5-Lightning`
     (tier below the selected Super), `tencent/Hy3`, `tencent/Hy4-preview`,
     `thinkingmachines/Inkling`(-Small), `ByteDance/Seed-*`,
     `meta-models/Muse-Glimmer-30B`.
   - `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`: experimental; V4.1-Flash covers the slot.
   - `nvidia/Nemotron-Content-Safety-3.5`: special-purpose safety classifier, not a
     general chat completion model.
   - `openai/gpt-oss-120b-Turbo` and `-Ultra`: serving variants of the already-seeded
     `openai/gpt-oss-120b` base — not new models.
   - Everything <70b (Qwen3.8-27B, Qwen3.6/3.5-35B-A3B, Qwen3.5-27B/9B, gemma-4-26B/31B,
     GLM-5.3-Flash's smaller siblings, Mistral/Nemo/24B, phi-4, granite, Ling-flash,
     Nemotron-Nano-30B, etc.): ticket says ignore.
   - Completeness **[R]**: all 102 chat-tagged rows in the 2026-09-26 dump are
     accounted for — 14 selected, the named exclusions above, and the remainder
     are <70b per id or fine-tune derivatives thereof. The dump is one `curl`
     away if this needs re-checking at implementation time (delistings happen —
     the Maverick precedent is this same week).

3. **`eligible: true` at seed/migration time.** `ROUTER_EPSILON` defaults to 1 (uniform
   exploration, `routerService.ts:60-65`), so all additions immediately take real traffic —
   large pool grows 6 → 20 (~5% of complex turns each, approximate: feedback
   weighting (#18) can force the leader once data accrues), the image-turn vision
   subset grows 2 → 10. That is the ticket's stated workflow: evaluate on live
   turns, delete in admin. Alternative (opt-in `eligible: false`) rejected — it
   would require 14 manual admin flips and produces no evaluation traffic.
   OQ-4 keeps the flag decision reviewable — and carries the one sharp edge:
   Kimi-K3 would take ~5% of complex turns at the pool's highest price.
4. **Capability flags and `contextLength` come from the live catalog + probes**, matching the
   #115 convention (`tools: true` probed for all; `vision: true` only where catalog tags say
   `vlm,vision` AND the image probe passed — 8 of the 14). `contextLength` is DeepInfra's
   advertised number, never invented.
5. **Delivery shape mirrors the established pattern**: `SEED_ENTRIES` rows (source of truth for
   fresh databases, the env-fallback, and the #158 sweep universe via `sweepModels`) + one
   `$setOnInsert` migration for already-populated deployments (app seeding is empty-pool
   recovery only — `ensureSeed` fires just when a tier read comes back empty,
   `modelConfigService.ts:206-219`, `315-318`) + migration test + updated seed tests.
   Admin deletions of the new rows after the migration has run stick (migrations run once).
   No client changes: the Models admin tab is DB-driven (#104).
   Known consequence: the #158 eval sweep universe grows 9 → 23 eligible rows
   (`scripts/run-evals.ts` consumes `sweepModels`) — full sweeps get
   proportionally costlier; accepted, noted here so it surprises no one.

## Remaining tasks (each safely deliverable in a single commit; suite green after each)

- [x] **Task 1 — seeds + seed tests.** In `src/server/services/modelConfigService.ts`:
      insert the 14 rows into `SEED_ENTRIES` between the Maverick entry (ends
      line 170) and the guard entry (starts line 171). Every row:
      `provider: 'deepinfra'`, `tier: 'large'`, `eligible: true`, `tools: true`,
      `contextLength` per the table above; `vision: true` on exactly the 8
      vision rows (V4.1-Flash, Kimi-K3, Kimi-K2.6, Qwen3.5-397B-A17B,
      Qwen3-VL-235B-A22B-Instruct, GLM-5.3-Flash, MiMo-V2.6-Pro, MiniMax-M3);
      no `vision` key on text rows (the mongoose default materialises
      `vision: false` on upsert — the existing test expectations rely on that).
      Cover the block with one `#170` comment stating: ZDR grounding (the
      Google/Anthropic exception), probe date/evidence, and the delisting
      discovery for context.
      Update `src/server/services/modelConfigService.test.ts`:
      - extend the large-tier `arrayContaining` expectation (lines 35–82) with
        the 14 new row objects (fields exactly as they will read back:
        `provider`/`model`/`tools: true`/`vision: true|false`/`contextLength`);
      - change the THREE total-count assertions from 10 to 24 — line 86
        (`seeds … pools on first read`), line 108 (`seeding is idempotent`),
        line 418 (`concurrent first reads`);
      - rewrite the vision-pool exact equality (lines 314–319) to the 10-row
        bytewise `provider, model` sorted set:
        `MiniMaxAI/MiniMax-M3, Qwen/Qwen3-VL-235B-A22B-Instruct,
        Qwen/Qwen3-VL-30B-A3B-Instruct, Qwen/Qwen3-VL-8B-Instruct,
        Qwen/Qwen3.5-397B-A17B, XiaomiMiMo/MiMo-V2.6-Pro,
        deepseek-ai/DeepSeek-V4.1-Flash, moonshotai/Kimi-K2.6,
        moonshotai/Kimi-K3, zai-org/GLM-5.3-Flash`
        (order re-derived against MongoDB's binary collation this pass —
        `MiniMaxAI` < `Qwen` < `XiaomiMiMo` < `deepseek-ai` < `moonshotai` <
        `zai-org`; `Qwen3-` < `Qwen3.5` since `-` < `.`; still confirm against
        the actual test run);
      - no other test in this suite needs touching (cool-off tests use
        DeepSeek-V3.2; gemma tests unaffected; env-override tests
        snapshot/restore whatever is present).
      Mirror this plan to `docs/plan-170-more-models.md` (workflow step 3).
- [x] **Task 2 — migration + its test.** `migrations/20260926000200-seed-more-models-routing.ts`
      (class `SeedMoreModelsRouting`; `20260926000200` is the next free slot after
      `20260926000100` — bump to the next free slot if another branch lands one first).
      14 `$setOnInsert` upserts keyed `{provider, model, tier}` mirroring the seed rows,
      one row per `updateOne` in a loop over a module-level `ROWS` array (the
      `20260920000000-seed-qwen3-vl-routing.ts` convention — never `$set`, so admin
      edits to existing rows are never clobbered). Two deliberate divergences from
      that precedent, both because migrations write through the raw driver and
      bypass mongoose defaults:
      - every migration row carries `disabledUntil: null` (the #168 seed shape —
        "field present-on-insert"; the Qwen3Vl migration predates #168);
      - text rows carry `vision: false` explicitly (the app seed gets this from
        the schema default; raw inserts do not — and the migration test asserts
        the read-back shape).
      `down` deletes exactly those 14 rows by `provider+model+tier`
      (loop of `deleteOne`, matching the precedent).
      Test `src/server/services/migrationSeedMoreModels.test.ts` mirroring
      `migrationSeedQwen3Vl.test.ts`: fixture = the 10-row deployed shape as of
      this branch (3 small incl. gemma `eligible: false`, 6 large incl. both VL
      rows, 1 guard) → `up` inserts the 14 (assert `countDocuments` 10 → 24;
      assert field-complete rows: tier/eligible/tools/vision/contextLength/
      `disabledUntil: null`, spot-check one vision row and one text row) →
      `up` idempotent on the migrated DB (second `up`, still 24) → `up` never
      clobbers admin edits (pre-insert one of the 14 keys with `eligible: false`,
      run `up`, assert it stays `false`) → `down` removes exactly the 14
      (count back to 10; the 10 fixture rows all still present).
- [x] **Task 3 — re-verify + docs + gate.** Re-run the live probes for all 14 at
      implementation time (catalog membership + `tools` acceptance; image-part
      acceptance for the 8 vision rows; delistings happen — drop any row that
      delisted or stopped accepting tools, and record it in this plan and the
      PR). Ensure the local stack is up (`npm run stack:up` if needed), run
      `npm run db:migrate`, and inspect with
      `npx tsx scripts/mongo.ts "await db.collection('providerroutings').find({tier:'large'},{projection:{_id:0,__v:0}}).sort({model:1}).toArray()"`.
      Add the `docs/progress.md` #170 entry. `npm run ci` must exit 0 (known
      `profile.purge.test.ts` #143 flake: re-run once before investigating).
      Update this plan's Status/tasks to reflect what landed, and archive per
      workflow.

## Verification

- `npm run ci` — the merge gate (server lint/format/typecheck/tests, client lint/format/tests/build).
- Live probe re-run at implementation time (task 3): a model that fails there is
  dropped from the batch, not seeded broken.
- Local migration inspection (task 3) — 24 rows, capabilities correct, idempotent
  re-run, `down` restores the 10-row shape.
- No new unit-test surface beyond the two touched suites; router/failover/admin
  behavior is pool-size-agnostic (existing tests already cover multi-row pools;
  `routerService.test.ts` mocks the pools entirely; the chat-route tests never
  touch `ProviderRouting`), and the admin Models tab is DB-driven so it needs no
  change.

## Assumptions (load-bearing, unconfirmed)

- "Partner models" = `google/*` + `anthropic/*`, read off DeepInfra's published
  privacy exception list. If Alex means something broader (say, also excluding
  closed-weight models served via DeepInfra), the list changes — though every
  selected model is open-weight under the privacy-page inference, so only a
  broader reading of "partner" would bite.
- Size rule = TOTAL params (decision 1b). If Alex meant active params, most of
  the batch (and the existing pool) would re-bucket; the ids' own convention and
  the existing Qwen3-235B row argue for total.
- DeepSeek-V4.1-Flash inherits the V4-Flash family size (284B/13B); the point
  release is a refresh, not a new architecture — >170b under any reading of the
  family. Vendor model card, not independently re-verified this pass.
- Parameter counts for closed flagships (Qwen3.8-Max et al.) are not published,
  hence excluded on verifiability grounds rather than included on brand grounds.
  The same verifiability rule excludes the undisclosed-size rows (Qwen3.8-Flash,
  MiMo-V2.6-Flash, Nemotron-3.5-Lightning, tencent/Hy*, Inkling, ByteDance/Seed).
- Kimi-K3's output price ($14.25/1M) is the pool's highest by far: ~24x the
  highest verifiable output price in today's pool (VL-30B, $0.60; the VL-8B
  alias's VL-235B backend is $0.88 → ~16x), and ~2.4x the next-priciest new row
  (Qwen3.8-2.4T, $6.00). Not a blocker — the point of the pool is evaluation —
  but under decision 3 it takes ~5% of complex turns from the moment the
  migration runs. OQ-4 carries exactly this edge.
- The Nemotron-3-Super-120B 429s are capacity, not capability: 1 busy response
  in the plan-write probe session, 2 of 3 busy in the review session ~10 minutes
  apart, then a clean 200. Runtime is covered by #168 cool-off (a busy endpoint
  cools off 6h and the turn re-routes via failover), and #178 (429 back-off) is
  already filed for the systematic version — but the recurrence means this row
  should be expected to oscillate in and out of the pool. OQ-2 puts the
  keep/drop call to Alex.
- "Featured" badges and vendor benchmark claims (e.g. GLM-5.3-Flash
  "outperforms GLM-5.2", MiMo "omnimodal") are marketing-status notes, verified
  against DeepInfra's site at plan-write where possible; none are load-bearing
  for the seed rows' correctness.

## Open questions

All four were queued on the ticket this pass (plan-169 precedent: queue state
is unobservable from inside a pass, so substance is re-queued regardless of
what the plan-write pass queued).

- **OQ-1 (queued; follow-up suggestion, NOT this ticket):** retire the two
  delisted seeds (`meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8`,
  `Qwen/Qwen3-VL-8B-Instruct`)? Both are gone from the catalog but still answer
  via legacy aliases **[R]** — so nothing is urgent — yet Maverick still holds
  ~1/6 of large-tier turns and VL-8B half of image turns as `eligible: true`
  seeds. Suggested as its own ticket so this branch stays additive per the
  ticket wording.
- **OQ-2 (rewritten this pass; queued):** the 70–170b bucket's size question is
  answered by the ticket body (70–170b is acceptable, only <70b is ignored),
  so the remaining doubt is capacity: `NVIDIA-Nemotron-3-Super-120B-A12B`
  returned "Model busy" 429 on 2 of 3 probe attempts in the review pass, and
  on ALL 6 attempts (~20 min apart) in the implementation pass — and on 2
  of 2 attempts again in the critic pass — the oscillation is worse than
  first recorded. At runtime one
  429 = a 6-hour cool-off (#168), so the row should be expected to oscillate
  out of the pool. Keep it as the bucket's one representative (newest and
  cheapest capable reasoner in that range; the only alternatives are 2024-era
  70Bs that lose on "prefer newer"), or drop the bucket from this batch?
  Answer trims tasks 1/2 by one row; nothing else moves.
- **OQ-3 (queued):** does the coding specialist
  `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` belong in a general-chat pool at
  all? Current lean: include and let the elimination process decide — it probed
  fine and users do ask code questions. Answer trims tasks 1/2 by one row.
- **OQ-4 (queued):** confirm `eligible: true` + uniform exploration (decision 3)
  is the intended evaluation mode, versus opt-in rows or a temporarily lowered
  `ROUTER_EPSILON`. Nothing in the tasks depends on the answer (a flip is one
  field in seed+migration across 14 rows), but it changes live traffic
  distribution the moment the migration runs — most sharply for Kimi-K3:
  ~5% of complex turns at $2.85/$14.25 per 1M tokens (the pool's highest
  price by ~16–24x).

No planned task depends on an open question: tasks 1–3 execute on the decisions
above; OQ-2/OQ-3 answers can only *trim* the batch (each row is independent and
additive), OQ-4 is a one-field flip, and OQ-1's outcome changes nothing on this
branch.

## Follow-ups

- Delisted-seed retirement (OQ-1): open a follow-up ticket if Alex agrees —
  not this branch (ticket says "add").
- #178 (429 back-off) is already filed; the Nemotron-3-Super recurrence logged
  here is more evidence for it, nothing new to file.
- #158 sweep cost: the universe grows 9 → 23 eligible rows with this change;
  if full sweeps become painful, a `--tier`/`--models` restriction on
  `run-evals.ts` is the natural trim (not needed now, not part of #170).
