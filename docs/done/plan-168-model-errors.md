# Plan #168 — model errors disable the model

Ticket: alex-moon/tova#168 — "Model errors should disable the model"
Branch: `feat/tv/168-170-model-pool` (shared with #170 — see
`docs/consolidate.md` for the consolidation sweep this landed through).
Supersedes PR #177 (`feat/168-model-errors`, closed), which held the same
deliverable on a pre-#176 base with a duplicate diagnostics service.

## Motivation

An LLM endpoint that fails should not be retried into for hours: each failure
cools the model off (`providerroutings.disabledUntil`, `MODEL_COOL_OFF_HOURS`,
default 6h, lazy expiry — no timers), the pools exclude it, and the turn
re-routes. When every model in the pinned pool is cooling off, the user gets a
dedicated, end-user-visible message — not a silent fall back to the single env
model (which would quietly absorb 100% of traffic and defeat both the cool-off
and the loud empty-pool error).

## Decisions

- **Cool-off at the routing layer, not the connector.** `disableModel` writes
  `disabledUntil` on every `providerroutings` row for the provider+model (a
  model can serve several tiers); pool reads exclude it lazily (expired or
  missing timestamp reads as "not disabled").
- **Three-case `listByTier`.** DB unusable → env fallback (pre-#168 behaviour,
  preserved); no eligible rows even after seeding → env fallback; eligible
  rows for the requested provider exist but all are cooling off →
  `AllModelsDisabledError`, NO env fallback. The cool-off check runs on the
  provider-filtered rows so the pinned `deepinfra` completion pools report
  "all cooling off" even when unrelated Groq rows elsewhere in the tier are
  healthy.
- **429 never disables (decision 2026-09-26, on the ticket).** A throttle is
  not an endpoint failure: until the dedicated back-off mechanism (#178)
  exists, a 429 fails the turn loudly with the retry-hint message, without
  disabling the endpoint or retry-draining the pool. `isRateLimitError`
  mirrors the 429 discrimination in `streamingErrorMessage` (status code plus
  Groq/Mastra message bodies rethrown without one).
- **413 and client aborts never disable** (from #173): a prompt-size failure
  is a prompt problem; an abort is the user hanging up.
- **A failed cool-off write stops the loop.** `disableModel` returns whether
  the write landed; on `false` the failover surfaces the original endpoint
  error — re-routing against an unchanged pool would re-pick the same broken
  endpoint and only add latency.
- **The router defers the drained tier's error to pick time.** `defaultConfig`
  reads both pools with `Promise.allSettled` and carries
  `smallCoolingOff`/`largeCoolingOff` flags; one drained tier must not fail
  turns the healthy tier could serve. Image turns and the classifier-error
  fallback report a drained large tier as all-disabled, never as a config gap
  ("No vision-capable models configured" would misreport a cool-off outage).
- **503 for all-disabled.** Both routes (and the client, alongside the 403
  geo block) surface the friendly message verbatim as the primary text.
- **Diagnostics consolidated lean (OQ-7, resolved 2026-09-26).** PR #177
  carried a second diagnostics mechanism (`ModelErrorStat`/
  `modelErrorStatsService`). Dropped: #175's `modelrouteerrors` tally at the
  `inferenceService` choke point already records every completion failure
  (status, category, redacted last message, count) and survives deploys. The
  admin Models tab reads that single collection — a cooling-off badge on the
  inventory rows plus an errors table (provider/model, status · category,
  count, last seen, last message; rows currently cooling off highlighted).
  No double-counting, no second write on the failure hot path.

## Done

- [x] `modelConfigService`: `AllModelsDisabledError` + lazy `isCoolingOff`;
      `readRows` returns all eligible rows; three-case `listByTier`;
      `disableModel` → `Promise<boolean>`
- [x] `modelFailover`: re-exports the error from `modelConfigService`;
      `isRateLimitError`; `MAX_ATTEMPTS` exported; loop stops on failed write
- [x] `routerService`: cooling-off flags on `RouterConfig`; allSettled pool
      reads; `pickFromTier` throws all-disabled at pick time; image-path and
      classifier-error rethrow paths
- [x] `routes/chat`: stream loop (`MAX_ATTEMPTS`, rate-limit exclusion,
      failed-write stop); pre-stream 503 all-disabled shape
- [x] `routes/admin` + `shared/contracts` + client: `{models, errors}`
      payload off `modelrouteerrors`; cooling-off badge; errors table;
      client 503 handling
- [x] Tests ported/adapted from PR #177 (failover, config, router drained
      tiers, chat 503s, stream retry/429/write-fail, admin payload,
      AdminView badge/table) — diagnostics-service tests dropped with the
      service; router tests adapted to #176's guard-vote contract
- [x] `npm run ci` green

## Follow-ups

- #178 — 429 back-off (short, env-tunable, separate persistence and badge
  from cool-off) until then 429'd turns fail loudly by design.
- #179 — persistent stdout log retention (Loki+Promtail); the
  `modelrouteerrors` tally covers classified completion failures only, not
  boot output / raw provider payloads.
