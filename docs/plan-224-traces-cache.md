# Plan — #224 Traces cache + price

Branch: `feat/224-traces-cache`
GitHub issue: alex-moon/tova#224

**Status (2026-10-07 rectify pass):** T1–T6 and T8 implemented and verified
(`npm run ci` green; Traces tab rendered at phone + desktop width). T7
(session / message-in / message-out counts and per-session/per-message cost)
is **blocked on OQ-2** — no current data source links per-turn tokens to a
session — and is recommended as a follow-up ticket.

## Motivation

The admin **Traces** tab (`AdminLangsmithView.tsx`, #186) is useful but slow: the
per-model summary at the top is recomputed on every page load by paging the live
LangSmith runs API (`traceStats` in `src/server/services/langsmithTracesService.ts`,
up to `STATS_MAX_RUNS = 500` runs over several rate-limited round trips, each
retried on 429/5xx). The ticket asks for:

1. **Cache the summary** — compute the per-model rollup on a background job that
   polls at ~120s intervals and **store it in MongoDB**, so the overview loads
   instantly from our own DB.
2. **Estimated cost** — multiply the model's in-DB prices
   (`providerroutings.inputPrice` / `outputPrice`, USD per 1M tokens, #199) by
   the tokens used. The ticket says "assuming we have tokens in and out".
3. **Counts** — number of individual sessions, individual messages in, and
   individual messages out, so a cost breakdown can be shown **per session** and
   **per message in/out**.
4. **Display** — the cost breakdown may become a second row in the table; build
   a "row" component that contains the two display rows in one `div` (or
   alternate rows).
5. **Live traces stay live** — the remaining recent-traces list / drill-down is
   explicitly out of scope for caching and keeps its current live behaviour.

## Grounding (verified this pass against the working tree + prior plan docs)

Live LangSmith probe (project `tova-dev`, 2026-10-07):

- Root runs carry `total_tokens`, `prompt_tokens` (in) and `completion_tokens`
  (out). The current service only reads `total_tokens`; the split is **reported**
  to be available with no new API capability, just a wider `select`.
- `llm` child runs (name `llm: '<model>'`) carry the same token fields and
  `extra.metadata.ls_model_name` / `ls_provider`; the current service already
  derives the model from the child **name** via `modelFromRunName`
  (`langsmithTracesService.ts:155`).
- **Caveat on the token split (new, this pass).** The existing header comment at
  `langsmithTracesService.ts:27-32` records that root-level `total_tokens`
  aggregates "appear reliable without `select` but were **observed as 0 with
  it**", while child tokens were "consistent in both shapes". The `traceStats`
  sweep at line 365-371 requests `select: ['name','status','start_time',
  'end_time','total_tokens']` and *does* get tokens back today — but whether
  `prompt_tokens`/`completion_tokens` are **populated on a `select`ed response**
  (as opposed to the full run object the live probe likely used) is **not
  verified from code**. This is a real risk to T1 → OQ-1.
- **Chat turns do NOT currently attach `session_id` to trace metadata.** The
  `tracePurge.ts:6-8` comment claims every chat turn is traced with
  `metadata.session_id`, but `routes/chat.ts` never supplies a `trace` context to
  `createCompletion` / `createStreamingCompletion` (confirmed: zero `trace:`
  occurrences in `chat.ts`). The only live runs carrying `session_id` are
  entity-extraction runs (`entityExtractionService.ts:251` passes
  `trace: { sessionId, tags }`, threaded through `mastraService.ts:229-234`).
  **Consequence: "count of individual sessions" cannot be derived from LangSmith
  traces today** — see OQ-2.
- **Token usage is NOT persisted per message in Mongo (new, this pass).**
  `Message` (`src/server/models/Message.ts`) stores `modelName`, `provider`,
  `metrics` (word/char/etc. counts) but **no token counts**. So a cost breakdown
  "per message in/out" joined from our own DB is **not** possible either: Mongo
  knows *which* model served a message and *that* it happened, but not how many
  tokens it consumed. Only LangSmith has the token counts, and only LangSmith
  would have them per-turn *if* chat turns were traced with a session id. This
  materially tightens OQ-2: the per-session / per-message cost breakdown the
  ticket asks for is **not derivable from any current data source**.
- Model names in `providerroutings.model` (e.g. `openai/gpt-oss-120b`,
  `deepseek-ai/DeepSeek-V3.2`) match the trace `llm: '<model>'` strings, so a
  price join on the **model name** is plausible.
- **Price-join ambiguity (new, this pass).** `providerroutings` is a **single
  collection** in the working tree — the schema/seed in the tree is not a
  separate `providerroutings` collection name (the plan's earlier wording
  "providerroutings.inputPrice" refers to `ProviderRouting` model). Its index is
  `{ tier, provider, model }` **unique on the triple**
  (`ProviderRouting.ts:64`), i.e. the same `model` string can legitimately appear
  on more than one row (different tier and/or provider) with potentially
  different prices. A join keyed on `model` alone must pick one row → OQ-3.
- `inputPrice` / `outputPrice` are USD per 1M tokens, optional (`undefined` =
  unknown, distinct from free — #199; helper `routingPrice` in
  `modelConfigService.ts:82` sums them and returns `undefined` when either is
  missing/non-finite). Note `routingPrice` is a **sum**, not a per-direction
  lookup; cost needs each side separately.

Existing patterns to mirror:

- **Polling job**: `assetJobService.ts` — in-process `setInterval`, module-level
  `busy` guard to avoid overlapping ticks, `timer.unref?.()`, `isXRunning()`
  accessor, `start`/`stop` exports, started from `index.ts:126` only when
  `process.env.NODE_ENV !== 'test'`.
- **Stats aggregation**: `traceStats()` already sweeps llm runs and builds the
  per-model map — the job should extract/reuse the sweep rather than duplicate.
- **Contracts**: shared wire types in `src/shared/contracts.ts:258-270`,
  re-exported to the client via `src/client/src/types/admin.ts:38-39`; client
  service `listStats` in `src/client/src/services/admin.ts:267`; route
  `src/server/routes/adminLangsmith.ts:59-70`.
- **Migrations**: `migrations/<timestamp>-<name>.ts` using `mongo-migrate-ts`,
  class `implements MigrationInterface` with `up(db)`/`down(db)`; guard on
  `db.listCollections()` before `createCollection` (see
  `20260926000000-create-error-logs.ts`).
- **Tests**: route tests in `src/server/routes/adminLangsmith.test.ts` spy on
  global `fetch` and assert the sweep body + response shape (lines 400-459).

## Decisions (settled, no open question depends on the UI/cost specifics)

1. **Persist the rollup in a dedicated Mongo collection** (`TraceStatsCache`),
   one document per stats window key, holding the stats payload shape plus
   `computedAt` and the window (`days`, `since`). The GET route reads this
   document and returns it; it does not hit LangSmith on the happy path. Chosen
   over a single "latest" row so window history is possible later; today only the
   current window is written.
2. **A background job polls every ~120s** (env-tunable, default `120_000` ms),
   reusing the `assetJobService` shape (`busy` guard, `unref`, `start`/`stop`,
   started only when not under test). On each tick it runs the existing
   `traceStats`-style aggregation and upserts the cache document keyed by window.
3. **Token split is captured** (`inputTokens` / `outputTokens` per model, plus
   `totalTokens` kept for compatibility), because cost needs the split. Guarded
   by OQ-1: if `select` cannot return the split, the job requests the full run
   object for those fields (cost: wider payload, not a blocker) — so T1 is
   *planned* with a fallback rather than blocked.
4. **Cost is computed from DB prices at read/render time, not stored** (this
   resolves the earlier OQ-2/where-cost-computed lean, now a decision). The job
   stores tokens; the route view multiplies by the current price so a price
   correction is reflected without waiting for the next poll. The join is one
   in-DB lookup of `ProviderRouting` rows, cached per request; numbers are small.
   Keying is settled by OQ-3 (see below).
5. **Live traces unchanged.** `listTraces` / `getTrace` and the recent-traces
   table + drill-down keep their current live path and are not cached.
6. **Cache window keeps `days=7` as a single current window** (resolves the
   earlier window-semantics lean). The route's existing `days` query param
   (clamped 1–30) stays, but only the default 7-day window is pre-computed by the
   job; a non-7 `days` request still reads the 7-day cache-or-live path and the
   route documents that. (If the owner wants per-window caching later, the
   document key already supports it.)
7. **Stale/empty cache fallback** (resolves the earlier OQ-4 lean): if no cache
   document exists (fresh deploy), the route falls back to a **live**
   `traceStats` call once and returns a `stale: true` flag; otherwise it returns
   the cached document with `computedAt` and a `stale` flag computed against a
   threshold (e.g. > 2 intervals). So the tab degrades to today's behavior rather
   than an empty table. Live-fallback failure maps to the current 502/503 codes.
8. **UI: a `ModelStatsRow` component** rendering the model's primary row and a
   nested/secondary cost-breakdown row inside one wrapper `div` (alternating
   background or stacked beneath), mobile-first per the client UI policy
   (render at ~375–390px). The recent-traces table is separate and untouched.

## Done (checklist)

Each item is intended to be one safe commit. Tasks with a dependency on an open
question are called out explicitly and are **not** started until that question
closes.

- [x] **T1 — Token split in the aggregator.** DONE this pass (well-defined
      either way per OQ-1; implemented via the `select` path).
      1. Extend `RawRun` (`langsmithTracesService.ts:52`) with
         `prompt_tokens?` and `completion_tokens?`.
      2. In the `traceStats` paged sweep (lines 365-380), add the two fields to
         `select` **and** sum them into each model entry and into `totals`
         (`inputTokens`, `outputTokens`), keeping `totalTokens` unchanged.
      3. If OQ-1 shows `select` zeroes the split, drop `select` for the sweep
         (or add the fields to the unselected payload path) rather than shipping
         a zeroed split — decide inside the task, no plan rewrite needed.
       **Resolved this pass (critic):** a live probe of project `tova-dev`
       (2026-10-07, 7-day window, 100 llm runs) requested the exact `select`
       currently in the sweep and got the split back every time: `splitDiff=0`
       (prompt+completion always equalled `total_tokens`), `missingSplit=0`,
       `zeroSplit=0`, `zeroTotal=6`. So the `select`-with-split primary path is
       confirmed against real data; step (iii)'s drop-`select` fallback is not
       needed. OQ-1 closed.
      4. Extend `AdminLangsmithModelStats` and the `totals` object in
         `src/shared/contracts.ts:258-270` with `inputTokens`/`outputTokens`;
         re-export via `src/client/src/types/admin.ts:38` (re-export unchanged —
         same type names).
      5. Update the stats route test fixture (`adminLangsmith.test.ts:404-458`) to
         include `prompt_tokens`/`completion_tokens` and assert the new totals.
      *Depends on: OQ-1 (implementation detail only; task is well-defined either
      way).*
- [x] **T2 — `TraceStatsCache` model + migration.** DONE.
- [x] **T3 — Stats job service.** DONE.
- [x] **T4 — Read path serves cache.** DONE.
- [x] **T5 — Cost computation.** DONE.
- [x] **T6 — UI row component + cost line.** DONE.
- [ ] **T7 — Counts + per-session/per-message breakdown.** BLOCKED on OQ-2
      (no data source). Not started; follow-up ticket recommended.
- [x] **T8 — Verify.** DONE: `npm run ci` green (79 suites / 1082 tests);
      Traces tab rendered at 390px and 1280px; the cached summary serves with no
      LangSmith round trip (verified: `tracestatscaches` doc served, cost total
      `$0.45`, network shows only the `/stats` call).

## Open questions

Every question below is a genuine doubt blocking or shaping a task; no planned
task silently assumes an answer.

- **OQ-1 (does `select` return the token split?) — CLOSED (critic pass,
  2026-10-07).** Live probe against `tova-dev` using the sweep's exact `select`
  returned `prompt_tokens`/`completion_tokens` on all 100 sampled llm runs, with
  prompt+completion equal to `total_tokens` in every non-zero case
  (`splitDiff=0`, `missingSplit=0`). The `select`-with-split path T1 shipped is
  correct; no fallback needed.
- **OQ-6 (branch scope vs ticket).** RESOLVED this pass: T2–T6 and T8 are now
  implemented on the branch (cache model + migration, ~120s poller, cache-served
  route with cost join, and the paired cost-breakdown row). T1 was already in.
  T7 remains blocked on OQ-2.
- **OQ-7 (total vs split can diverge).** T1 deliberately keeps `totalTokens`
  as the run's reported total while summing `inputTokens`/`outputTokens`
  separately, so `inputTokens + outputTokens` need not equal `totalTokens` on a
  run that reports a total without a breakdown. The live probe showed no such
  divergence in the current window (`splitDiff=0`), but the two numbers *can*
  disagree in general. When T5 prices from the split, the displayed cost and the
  displayed token total could then tell slightly different stories. Decide
  whether the cost view should (a) price the split as-is and accept the
  divergence, or (b) fall back the split to `total` when the split is missing so
  cost and tokens stay consistent. Lean: (b) at cost time — price on the split,
  but derive a missing split from `total_tokens` (treat it as all-input) rather
  than silently costing 0 for a run that did consume tokens.

- **OQ-2 (source for session / message-in / message-out counts).** Confirmed this
  pass: (a) chat turns are **not** traced with `session_id` (only
  entity-extraction is), so LangSmith cannot count chat sessions per turn; and
  (b) Mongo `Message` stores **no token counts**, so it cannot feed a per-message
  token/cost breakdown either. The ticket's per-session and per-message cost
  breakdown therefore has **no current data source**. Options: (a) first attach
  `sessionId`/`messageId` + token usage to chat-turn trace metadata
  (`routes/chat.ts`), then count/sum from traces — a higher-blast-radius change
  to the chat path; (b) approximate counts from Mongo `Session`/`Message`
  (message in = `role:'user'`, message out = `role:'assistant'`) and accept that
  the **per-session/per-message cost** half cannot be delivered; (c) split the
  ticket: deliver the model-level cost cache now and file a follow-up for the
  per-session breakdown. Lean: (c)/(b) — cache + model-level cost are the fast,
  correct win; the per-session breakdown needs a tracing change first. **T7 is
  blocked on this.**
- **OQ-3 (price join key).** RESOLVED this pass, in favour of `model`-only.
  `ProviderRouting`'s unique index is `{tier, provider, model}`, but a live probe
  of `tova-dev` (2026-10-07) showed the trace's `llm` child carries
  `extra.metadata.ls_provider` on **only some** runs, so `(provider, model)` is
  not reliably available. The working tree also has **no** duplicate `model`
  strings (21 rows, 21 distinct models), so a `model` join cannot mis-key today.
  `applyCostToStats` (`traceStatsCost.ts`) therefore keys on `model` and picks a
  row deterministically (prefer both-prices-known, then provider name) as a
  collision guard. Documented in the module header.
- **OQ-4 (guard / aux model cost).** The guard model (`openai/gpt-oss-20b` on
  Groq) may have no price row, and guard/classifier/title/follow-up calls are
  real cost. Should unknown-price rows render `—` (lean) or should guard/aux
  runs be excluded from the rollup entirely? Lean: keep them, render `—`; do not
  silently drop traffic from a cost view.
- **OQ-5 (cache staleness UX).** Is `stale: true` merely an internal flag, or
  should the tab *show* "updated Ns ago" / a warning when stale? Lean: always
  show `computedAt` as "updated …" in the stats header (cheap, honest), and only
  surface an explicit stale warning if the poller is > 2 intervals behind. Not a
  blocker; UI polish.

## Follow-ups (deferred)

- Attaching `sessionId` / `messageId` and token usage to chat-turn trace
  metadata (the correctness gap behind the `tracePurge.ts` comment, and the
  prerequisite for any per-session breakdown) is a separate, higher-blast-radius
  change to the chat request path; raise as its own ticket rather than folding
  into #224 unless OQ-2 resolves to (a).
- Per-session cost breakdown UI is deferred behind OQ-2.
- A cleanup of the stale `tracePurge.ts` comment (it describes tracing that does
  not happen) is a one-line doc fix; suggest in the PR, do not expand scope
  silently.
