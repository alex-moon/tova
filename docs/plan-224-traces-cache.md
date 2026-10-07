# Plan — #224 Traces cache + price

Branch: `feat/224-traces-cache`
GitHub issue: alex-moon/tova#224

**Status (2026-10-07 logging pass):**

- **T1–T6, T8 are implemented and verified on the branch** (`npm run ci` green at
  the time; Traces tab rendered at 390px and 1280px). The model-level cache +
  estimated cost are live.
- **T9–T11 are now implemented and verified** (this pass): token usage is
  threaded through the neutral LLM boundary, chat turns carry a `sessionId`
  trace, and the assistant `Message` persists the turn's token usage. This is
  the "logging" half of the owner's 2026-10-07 directive. See "To do" below.
- **T12 (the per-message admin surface) is the remaining deliverable.** Its
  data source is now in place; the UI shape is OQ-10 (still open, owner
  preference). Counts (T12.1) already have a source and could ship next.
- **Honesty note on the branch:** the earlier T7 wording ("no data source,
  blocked") was correct only for *LangSmith-derived* data. Mongo `Message` stored
  no token counts *today*, but the chat path received the provider's usage on
  every turn — it was simply never read from the connector result. That wiring
  gap is now closed (T9–T11).

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
   (`ProviderRouting.inputPrice` / `outputPrice`, USD per 1M tokens, #199) by
   the tokens used, "assuming we have tokens in and out".
3. **Counts** — number of individual sessions, messages in, messages out, so a
   cost breakdown can be shown **per session** and **per message in/out**.
4. **Display** — the cost breakdown may become a second row in the table; build
   a "row" component containing the two display rows in one `div` (or alternate
   rows).
5. **Live traces stay live** — the recent-traces list / drill-down keeps its
   current live behaviour.

Owner follow-up (2026-10-07, verbatim intent): implement the missing per-message
token logging, then build the per-message admin side, accepting that numbers will
be skewed until the logging has run for a while.

## Grounding (verified this pass against the working tree, node_modules, and prior probes)

### LangSmith side

- Root runs carry `total_tokens`, `prompt_tokens` (in), `completion_tokens`
  (out). The service reads `total_tokens`; T1 already widened `select` to add the
  split (`langsmithTracesService.ts:52`, `:377`) and sums it per model and into
  `totals` (`:399`, `:416`, `:427`).
- `llm` child runs (name `llm: '<model>'`) carry the same token fields and
  `extra.metadata.ls_model_name` / `ls_provider`; the service derives the model
  from the child **name** via `modelFromRunName` (`langsmithTracesService.ts:155`).
- **`select` with the split is confirmed against real data** (critic probe,
  project `tova-dev`, 2026-10-07, 7-day window, 100 llm runs): prompt+completion
  always equalled `total_tokens` (`splitDiff=0`, `missingSplit=0`, `zeroSplit=0`,
  `zeroTotal=6`). No drop-`select` fallback is needed. This **closes OQ-1**.
- **Chat turns do NOT attach `session_id` to trace metadata.** The
  `tracePurge.ts:6-8` comment claims every chat turn is traced with
  `metadata.session_id`, but `routes/chat.ts` never supplies a `trace` context to
  `createCompletion` / `createStreamingCompletion` (zero `trace:` occurrences in
  `chat.ts`). Only entity-extraction runs carry `session_id`
  (`entityExtractionService.ts:251` passes `trace: { sessionId, tags }`, threaded
  through `mastraService.ts:229-234`). This is the correctness gap the owner wants
  closed (T9), and it is also what makes per-turn LangSmith traces attributable
  to a session.
- Model names in `ProviderRouting.model` match the trace `llm: '<model>'` strings,
  so a price join on the model name is valid.

### Price side

- `inputPrice` / `outputPrice` are USD per 1M tokens, optional (`undefined` =
  unknown, distinct from free — #199). `routingPrice` in `modelConfigService.ts:82`
  sums them and returns `undefined` when either is missing/non-finite; cost needs
  each side separately.
- **Price-join key resolved to model-only.** `ProviderRouting`'s unique index is
  `{tier, provider, model}` (`ProviderRouting.ts:64`), so one model string *can*
  legally appear on several rows. But a live `tova-dev` probe (2026-10-07) showed
  the trace's `llm` child carries `ls_provider` on **only some** runs, so
  `(provider, model)` is unreliable; and the working tree has **no** duplicate
  model string (21 rows / 21 distinct models). `applyCostToStats`
  (`traceStatsCost.ts:29`) therefore keys on `model`, picks a row
  deterministically (prefer both-prices-known, then provider name), and renders
  `—` (not `$0`) when no finite price is available. This **closes OQ-3**; the
  tie-break is a future-collision guard, not live behaviour.

### Token-usage side (new, this pass — the key grounding for T9–T12)

- **`@mastra/core` exposes token usage on both connector paths, and it is
  currently thrown away.**
  - `agent.generate(...)` resolves to `FullOutput`, which has `usage` (last step)
    and `totalUsage` (across all steps), each a `LanguageModelUsage` with
    `inputTokens`, `outputTokens`, `totalTokens` (`number | undefined`).
    `mastraService.ts:817-836` returns only `choices` + `toolResults`, discarding
    usage.
  - `agent.stream(...)` resolves to an output object exposing
    `get totalUsage(): Promise<LanguageModelUsage>` and
    `getFullOutput(): Promise<FullOutput<OUTPUT>>`. `mastraService.ts:838-848`
    returns `toNeutralStream(result.fullStream)` only, discarding usage.
  - Source of truth: `node_modules/@mastra/core/dist/stream/base/output.d.ts`
    (`FullOutput` lines 26-56, `totalUsage` getter line 209) and
    `.../stream/types.d.ts` (`LanguageModelUsage = LanguageModelV2Usage & …`,
    line 1116; `LanguageModelV2Usage` at
    `.../_types/@ai-sdk_provider-v5/dist/index.d.ts:1104-1118`).
- **Nullability matters:** `inputTokens`/`outputTokens`/`totalTokens` are all
  `number | undefined`, so any cost/total computed from them must treat absent as
  unknown, mirroring the LangSmith side's "absent → 0, total kept separately"
  rule.
- **`Message` stores no token counts today**
  (`src/server/models/Message.ts:116-139`): `metrics` has word/char/LLM
  classification fields only. `modelName` / `provider` record *which* model
  served the turn, not how many tokens it used.
- **Multi-step turns make "per message" ambiguous.** A tool-using turn runs
  `maxSteps: 12` (`mastraService.ts:217`), so `usage` (last step) and `totalUsage`
  (all steps) differ. A single assistant `Message` should store the **turn total**
  (`totalUsage`), not the last step — OQ-8.
- **Auxiliary calls** (title, guard classification, follow-ups, entity extraction,
  metrics) are also LLM calls with real cost, but they are not chat `Message`
  rows. They are out of scope for per-message logging; the model-level cache
  already captures them via LangSmith llm runs, so the two views will not sum to
  the same number (documented, not a bug).

### Existing patterns to mirror

- **Polling job**: `assetJobService.ts` — in-process `setInterval`, module-level
  `busy` guard, `timer.unref?.()`, `isXRunning()` accessor, `start`/`stop`,
  started from `index.ts:126/130` only when `process.env.NODE_ENV !== 'test'`.
- **Contracts**: `src/shared/contracts.ts:250-294`; re-exported to the client via
  `src/client/src/types/admin.ts:35-42`; client service `AdminLangsmithService`
  in `src/client/src/services/admin.ts`; route
  `src/server/routes/adminLangsmith.ts`.
- **Migrations**: `migrations/<timestamp>-<name>.ts`, `mongo-migrate-ts`,
  `up(db)`/`down(db)`, guard on `db.listCollections()` before `createCollection`
  (see `20261007000000-create-trace-stats-cache.ts`).
- **Tests**: route tests spy on global `fetch` and assert the sweep body +
  response shape (`src/server/routes/adminLangsmith.test.ts`); chat route tests
  mock `@mastra/core/agent` and `mockGenerate`/`mockAgentStream`
  (`src/server/routes/chat.stream.test.ts:1-60`).

## Decisions (settled — moved out of Open questions)

These were open in earlier drafts and are now resolved by code already on the
branch or by a probe. They are recorded here so no task depends on an open
question.

1. **Persist the rollup in `TraceStatsCache`**, one document per window key,
   holding the stats payload shape plus `computedAt`, `days`, `since`. The GET
   route reads it; it does not hit LangSmith on the happy path. *(T2, done.)*
2. **A background job polls every ~120s** (env-tunable, default `120_000` ms),
   reusing the `assetJobService` shape, started only when not under test. It
   upserts the cache document keyed by window. *(T3, done.)*
3. **Token split is captured** (`inputTokens`/`outputTokens` per model, plus
   `totalTokens` kept for compatibility). OQ-1 closed: the `select`-with-split
   path is confirmed; no fallback. *(T1, done.)*
4. **Cost is computed at read/render time, not stored.** The job stores tokens;
   the route multiplies by the current price, so a price correction shows without
   waiting for the next poll. Join is one allowlisted `ProviderRouting` lookup,
   cached per request. Keying resolved in grounding above. *(T5, done.)*
5. **Live traces unchanged.** `listTraces` / `getTrace` and the recent-traces
   table + drill-down keep the live path. *(T8, verified.)*
6. **Cache window is a single current window, `days=7`.** The route's `days`
   param (clamped 1–30) stays, but only the 7-day window is pre-computed; a non-7
   `days` request falls back to the cached-or-live path. The document key already
   supports per-window caching later. *(Done; route documents this.)*
7. **Stale/empty cache fallback.** No cache document (fresh deploy) or cache
   older than `2 × interval` → live `traceStats` once with `stale: true`;
   otherwise serve the cached document with `computedAt` and `stale: false`. Live
   failure maps to the existing 502; unconfigured maps to 503. *(Done.)*
8. **UI: `ModelStatsRow`** renders the model's primary `<tr>` plus a paired muted
   cost-breakdown `<tr>` (`in … · out … · est. …`), plus a totals footer. Mobile
   first. *(T6, done; verified at 390px.)*
9. **Token-usage wiring is in scope and approved** (owner 2026-10-07). Per-message
   usage is read from the connector result and persisted on the assistant
   `Message`; per-turn LangSmith trace metadata gains `sessionId`. *(New T9–T12.)*
10. **Per-message cost is computed at read/render time**, same stance as model
   cost: store `inputTokens`/`outputTokens` on the message, join `ProviderRouting`
   prices when the admin view renders. *(New T11.)*
11. **Session / message-in / message-out counts come from Mongo, not LangSmith.**
    Message in = `role:'user'`, message out = `role:'assistant'`, sessions =
    distinct `Message.sessionId` (or `Session` rows) in the window. No dependency
    on traces. *(New T11.)*

## Done (checklist, with the concrete steps that were taken)

Each item was one safe commit.

- [x] **T1 — Token split in the aggregator.**
  1. `RawRun` gained `prompt_tokens?` / `completion_tokens?`
     (`langsmithTracesService.ts:52`).
  2. The paged sweep adds both fields to `select` and sums them per model and
     into `totals` (`inputTokens`, `outputTokens`), keeping `totalTokens`
     unchanged (`:377`, `:399`, `:416`, `:427`).
  3. `AdminLangsmithModelStats` and the `totals` object gained
     `inputTokens`/`outputTokens` (`contracts.ts:258-294`); client re-export
     unchanged (same type names).
  4. Route fixture + edge-case test updated (absent/null split counts as 0,
     totals preserved). OQ-1 closed by the live probe (see Grounding).
- [x] **T2 — `TraceStatsCache` model + migration.** Model at
      `src/server/models/TraceStatsCache.ts` (one doc per `windowKey`, unique
      index, token split stored, no price); migration
      `20261007000000-create-trace-stats-cache.ts` pre-creates the collection and
      index, guarded by `listCollections()`; `down` drops the collection.
- [x] **T3 — Stats job service.** `traceStatsCacheService.ts`:
      `runTraceStatsTick` runs `traceStats(days)` and upserts by `windowKey`;
      `start`/`stop`/`isTraceStatsPollerRunning`, module-level `busy` guard,
      `unref`ed interval, default `120_000` ms; started from `index.ts:130`
      outside tests; `TRACE_STATS_STALE_MS = 2 × interval`.
- [x] **T4 — Read path serves cache.** `GET /admin/langsmith/stats` reads
      `TraceStatsCache` for the 7-day window; fresh → serve cached + cost join,
      `stale:false`; missing/stale → live sweep + cost join, `stale:true`.
- [x] **T5 — Cost computation.** `traceStatsCost.ts`: `pickPriceRow`,
      `estimateCostUsd`, `applyCostToStats` (allowlisted `$in` query by model,
      per-model + totals `estimatedCostUsd`, `null` when unknown). Unit tested.
- [x] **T6 — UI row component + cost line.** `ModelStatsRow` in
      `AdminLangsmithView.tsx`: paired rows, totals footer, `formatCost` renders
      `—` for null, `updated <time>` suffix.
- [x] **T8 — Verify (as of the branch).** `npm run ci` green; Traces tab rendered
      at 390px and 1280px; cached summary served from Mongo with no LangSmith
      round trip (only `/stats` fired, total `$0.45`).
      *Caveat: CI's full pass is environment-sensitive (see Verification).*

## To do — per-message logging + per-message admin view (owner directive)

These are the new tasks. They build on the confirmed Mastra usage exposure in
Grounding. Each is intended to be one safe commit, ordered by dependency.

- [x] **T9 — Thread token usage through the neutral LLM boundary. DONE.**
      `TokenUsage` added to `llmTypes.ts` on `NeutralCompletion.usage` and
      `NeutralStreamChunk.usage`; `normaliseUsage` in `mastraService.ts` drops
      absent/NaN fields (unknown ≠ 0). Non-streaming reads
      `totalUsage ?? usage`; streaming emits one trailing `usage` chunk after
      the real chunks (OQ-9 resolved to design (a) — `totalUsage` is a promise
      that settles once the stream drains, so awaiting after the loop cannot
      race). Tests: `mastraUsage.test.ts` (6).
  1. Add `usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }`
     to `NeutralCompletion` and a `usage` field (or a final `usage` chunk) to
     `NeutralStreamChunk` in `src/server/services/llmTypes.ts`. Keep both
     optional so existing callers are untouched.
  2. In `mastraService.ts` `createCompletion` (`:817`), read
     `result.totalUsage ?? result.usage` from the `FullOutput` and include it on
     the returned `NeutralCompletion`. Do **not** change the `choices` shape.
  3. In `createStreamingCompletion` (`:838`), after the stream drains, surface
     usage. Two candidate designs, pick one and document it:
     (a) yield one final `{ usage }` chunk from `toNeutralStream` after the real
     chunks (`await result.totalUsage`), or (b) await `result.totalUsage` after
     the `for await` loop in `chat.ts` and read it off the output object. Prefer
     (a) if `toNeutralStream` can await the getter without racing the stream end;
     otherwise (b) is simpler and keeps `toNeutralStream` pure. **This choice is
     OQ-9 until tested.**
  4. Normalise `undefined` sub-fields to absent (not 0) at the boundary, so a
     provider that reports nothing is distinguishable from one that reports 0
     (mirror the #199 unknown ≠ free stance).
  5. Tests: extend the existing connector/`mastraService` test doubles to return
     usage and assert it survives the boundary; add a no-usage case.
- [x] **T10 — Attach `sessionId` trace metadata to chat turns. DONE.**
      `routes/chat.ts` passes `trace: { sessionId: String(session!._id) }` to
      `createCompletion` (persisted non-streaming) and `createStreamingCompletion`
      (persisted streaming, spread-gated on `!zdr`); the ZDR paths pass no trace.
      `tracePurge.ts` header comment corrected to say persisted turns only.
      Tests: `chat.zdr.test.ts` asserts the session id reaches the provider on
      both persisted routes and is absent on both ZDR routes.
- [x] **T11 — Persist per-message token usage on the assistant `Message`. DONE.**
      Optional `usage` sub-document added to `Message.ts` (inputOutput/total,
      `default: undefined`, no migration). Both routes attach the turn usage
      (turn total per OQ-8 lean) to the assistant message only. Tests:
      `chat.test.ts` / `chat.stream.test.ts` assert persistence and clean
      omission when the provider reports nothing.
- [ ] **T12 — Per-message / per-session admin breakdown.** *(Data source now in
      place after T9–T11; T12.1/T12.2 are unblocked, T12.3 waits on OQ-10.)*
  - Sub-tasks depend on the shape chosen for the admin surface, which is **OQ-10**
    (extend the existing Traces tab vs a new admin tab). The parts that do **not**
    depend on that choice, and can be built regardless:
  1. **Counts from Mongo** (decision 11): a route method returning, for a window,
     session count, message-in count (`role:'user'`), message-out count
     (`role:'assistant'`), and the summed `inputTokens`/`outputTokens` from
     assistant `Message.usage`. Explicitly note the skew: only turns after T11
     shipped carry `usage`; count totals and token totals cover different rows
     for a while.
  2. **Cost join**: reuse `estimateCostUsd` keyed on `Message.modelName`
     (same model-only tie-break as `traceStatsCost.ts`).
  3. **UI**: render alongside/under the model summary. Mobile-first, Playwright
     verified at ~375–390px. Whether it is a per-session table, a per-message
     list, or a second cost row under the model table is OQ-10.
  4. Tests: route contract test + client render test; a mixed-usage fixture
     (some messages with usage, some without) to prove `—` handling.

## Verification

- **Gate:** `npm run ci` must exit 0 before the work is called done. Iterate with
  `ci:server` / `ci:client` and the per-step scripts.
- **Known environment flakiness (pre-existing, not caused by #224):** the
  pr-decision comment records `markdownConversion.test.ts` and
  `modelConfigService.test.ts` failing on order-dependent shared local-Mongo
  state, reproducing on a clean `main` worktree; each passes in isolation. Do not
  treat those as #224 regressions, but **do** re-run the specific #224 suites and
  the full gate after T9–T12 land.
- **CI Actions:** the owner asked to check CI runs against the PR and fix
  them. Before finalising, fetch the PR's check runs (when writing back is
  allowed) and confirm the `ci` workflow is green, or fix the cause. The workflow
  detects changed areas (`.github/workflows/ci.yml`) so server + client steps run
  for these changes.
- **UI:** every new surface renders at a phone viewport (390px) with the
  `playwright-cli` skill, not code inspection.
- **Live probes:** for anything touching LangSmith tokens or Mastra usage, prefer
  a live `tova-dev` probe (as the critic did for OQ-1) over an assumption.

## Open questions

Only genuine doubts that block or shape a task appear here. Resolved items
(OQ-1, OQ-3, OQ-6, OQ-7, and OQ-2's "which option") have been promoted into
Grounding and Decisions above.

- **OQ-2 (source for session / message counts) — RESOLVED to option (a) by the
  owner (2026-10-07).** Per-message token usage will be logged on the chat path
  (T9/T11) and `sessionId` attached to chat-turn trace metadata (T10); counts come
  from Mongo (decision 11). The per-session/per-message cost breakdown is now
  derivable. No task is blocked on this.
- **OQ-5 (cache staleness UX).** Is `stale: true` merely internal, or should the
  tab warn? The branch already shows `updated <time>` and appends `· updating…`
  when stale, which is the earlier lean. Remaining doubt: whether >2 intervals
  deserves an explicit warning. Low stakes; no task depends on it. *To close:
  owner preference.*
- **OQ-8 (turn total vs last step) — RESOLVED to `totalUsage` by T11.** A
  tool-using turn runs up to 12 steps, so `totalUsage` (all steps) and `usage`
  (last step) differ. `mastraService` reads `totalUsage ?? usage`, and the
  assistant message persists that turn total — the turn's real spend, matching
  the model-level LangSmith rollup's spirit.
- **OQ-9 (streaming usage transport) — RESOLVED to design (a) by T9.** The
  connector emits one trailing `usage` chunk after the real chunks;
  `toNeutralStream` stays pure and `totalUsage` (a promise on the stream output)
  settles once the stream drains, so awaiting after the loop cannot race the end.
  Pinned by `mastraUsage.test.ts`.
- **OQ-10 (admin surface shape for the breakdown).** Per OQ-2 being resolved,
  per-message cost is now deliverable, but the ticket's UI ask is ambiguous:
  a per-session table, a per-message list, or extra cost rows in the existing
  model table. Lean: a per-session summary (session → messages in/out, tokens,
  est. cost) as a second collapsible section under the model stats, since the
  owner's stated value is "cost breakdown per session". Confirm before T12's UI
  sub-task. *To close: owner preference.* Still open — blocks only T12.3.
- **OQ-11 (does `Message.modelName` reliably identify the priced model?).**
  `Message.modelName` is set from `routingResult.model` on both routes, which is
  the same string space as `ProviderRouting.model`. But historical messages may
  have `modelName` in an alias form or empty. The per-message cost join will
  render `—` for those; confirm that is acceptable rather than falling back to a
  provider-level default. *To close: sample the local/dev DB for distinct
  `modelName` values before T12.*
- **OQ-12 (usage availability across clients/providers).** `LanguageModelUsage`
  fields are `number | undefined`; a provider version that omits them yields
  absent usage, rendering `—`. Unknown how often Groq vs DeepInfra populate the
  split. This does not block T9–T12 (absent is handled) but bounds the value of
  the per-message view; a live sample after T9 ships would quantify it. *To
  close: post-T9 probe.*

## Follow-ups (deferred)

- **Auxiliary-call cost** (title, guard, follow-ups, entity extraction, metrics)
  is real spend but not attached to any `Message`. The model-level cache already
  covers it via LangSmith llm runs; the per-message view will not sum to it. If
  the owner later wants a full per-turn cost, auxiliary usage would need its own
  persistence — out of scope.
- **Per-window caching** (the `TraceStatsCache.windowKey` already supports it):
  only if the owner wants non-7-day summaries pre-computed.
- The stale `tracePurge.ts` comment is fixed as part of T10 (not deferred).
