# Plan — #233 Delete dead code from the tier-era router

## Motivation

Part of the #232 routing replacement (fixed roster + hedged provider racing).
#232 landed the new roster runtime **alongside** the tier router (SP0, "build
alongside, then delete"). This ticket is the deletion: remove the tier-based
router, the guard classifier's routing role, ε-exploration, feedback weighting,
and their seeds/migrations/env, so the app runs only on the roster/racing path.

Evidence inventory (file:line) lives in `alex-moon/tova#233`.

## Decisions

Resolutions for the ticket's open questions, grounded in the delivered #232
code. Where the ticket reserved an owner call, the decision and its basis are
stated below.

1. **OQ3 — deletion strategy: phased, now complete.** The parent plan already
   chose "build alongside, then delete" (`docs/plan-roster.md`). #232 is merged
   to `epic/roster` (PR #239), so the replacement exists and this is the
   mechanical second phase. No coexistence remains after this ticket.

2. **OQ1 — `withModelFailover` does not survive.** After the tier router is
   gone it has no caller (only `chat.ts`'s tier fallback used it). The roster
   runtime does its own per-model fallback in `racingService.ts`. **Delete the
   loop and `MAX_ATTEMPTS`/`FailoverOutcome`, keep the error-classification
   helpers** (`isClientAbort`, `isRateLimitError`, `isPromptSizeError`) because
   `racingService.ts` imports them. `isOverloadError` stays in
   `providerErrors.ts` (leaf, shared by racing + the error tally).

3. **OQ2 — `routingBand` is deleted outright.** It exists solely to key the
   feedback tallies in `ModelMetricStat` (`feedback.ts` reads
   `message.routingBand`; the router consumed `getFitWeight(band, model)`).
   With feedback weighting removed there is no consumer, so a "persist as
   analytics" reading would be dead data. Delete the field from `Message`, the
   `buildRoutingBand` helper, and every persistence site. The thumbs up/down
   **route** stays as a user feature; only its stats plumbing goes.

4. **OQ4 — migration strategy: remove the tier/pool seeds, defer the price
   rewrite to #235.** The roster lives in a **new `modelroster` collection**
   (#232), so the tier-era `providerroutings` rows are no longer read by
   routing. The pool-seeding migrations would reseed dead data; remove them.
   The `backfill-model-prices` migration targets `providerroutings` tier rows;
   re-attaching prices to **roster** rows is exactly the cost ticket **#235**,
   so this ticket deletes the stale backfill and **#235 owns the roster price
   path** (cross-referenced, not silently dropped). A down-migration is
   impossible once tiers are dropped; the roster collection is the forward
   state, seeded by `20261008000000-seed-model-roster`.

5. **OQ5 — `ModelRouteError`/error tally is tier-free and stays.**
   `modelErrorTally.ts` reads only provider/model/status (written by
   `inferenceService`), with no tier coupling. `isOverloadError` stays as its
   shared classifier. Confirmed correct.

6. **`modelConfigService.ts` is reduced to its tier-free survivors.** Keep
   `disableModel`/`coolOffHours`/`overloadCoolOffMinutes`/`AllModelsDisabledError`/
   `providerErrors`-driven classification and `routingPrice` (imported by
   `rosterConfig.ts`). Delete `ModelTier`, `DEFAULT_MODEL_ENV`, `TIER_PROVIDER`,
   `GUARD_ENV`, `SEED_ENTRIES`, `ensureSeed`, `fromEnv`, `readRows`,
   `listByTier`, `completionsPoolFor`, `sweepModels`, `ModelRef`'s tier use.
   `sweepModels` callers move to #236 (evals swarm the roster). **However**:
   `evalRunService.ts` currently imports `sweepModels`/`ProviderName`. To keep
   this ticket shippable without pre-empting #236, `ProviderName` stays (it is
   a plain provider-name union, not tier machinery) and `sweepModels` is
   replaced by a roster-backed sweep helper so evals keep working. See
   "Sequencing note" below.

7. **Feedback stats service + model deleted whole.** `modelMetricsStatsService.ts`
   and `models/ModelMetricStat.ts` go; `feedback.ts` keeps the route but drops
   the stats writes; `admin.ts` drops the tally read.

### Sequencing note (decision 6)

#236 ("evals sweep the fixed roster") is a separate ticket. Deleting
`sweepModels` outright would break `evalRunService.ts` until #236 lands, which
would leave this ticket non-shippable. To keep #233 a self-contained deletion
**and** leave evals working, `sweepModels` is re-pointed at the roster
(`rosterConfig.ROSTER_SEED`) as a thin replacement with the same
`{ provider, model }[]` shape, keeping the deepinfra/groq connector wiring
intact. #236 then extends it to the actual roster universe. This is the minimal
bridge so the deletion does not strand a caller.

## Done

- [ ] Delete `services/routerService.ts`, `services/routerService.test.ts`.
- [ ] Delete `services/modelMetricsStatsService.ts` (+ test),
      `models/ModelMetricStat.ts`.
- [ ] Trim `services/modelFailover.ts` to classification helpers (+ update
      test); drop `withModelFailover`/`MAX_ATTEMPTS`/`FailoverOutcome`.
- [ ] Reduce `services/modelConfigService.ts` to tier-free survivors (+ update
      test); re-point `sweepModels` at the roster; keep `routingPrice`.
- [ ] `feedback.ts`: keep route, drop `recordFeedback`/`clearFeedback`.
- [ ] `chat.ts`: remove the tier fallback branch entirely; racing is the only
      path. Remove `buildRoutingBand`, `guardHistoryFromDocs`,
      `routingBand` persistence, tier imports (`routeQuery`/`withModelFailover`
      etc.). Keep error classification via `modelFailover` helpers.
- [ ] `models/Message.ts`: remove the `routingBand` field.
- [ ] `admin.ts`: drop `ModelMetricStat` read from `/models`.
- [ ] `config/index.ts`: remove `routing.smallModel`/`guardModel`/
      `guardMaxTokens`/`epsilon` and the `ROUTER_*` reads that die with them.
- [ ] Delete tier/pool migrations + their tests; delete stale
      `scripts/eval-classify-models.ts`.
- [ ] Docs: update `README.md` Model Routing Contract, `docs/overview.md`,
      `docs/progress.md`; note the roster as the routing story.
- [ ] `npm run ci` green; migrations run clean on a fresh DB.

## Follow-ups

- **#234** admin Models + Compare tabs for the roster.
- **#235** cost tracking per (model, provider) on roster rows; owns the roster
  price seed that replaces the deleted `backfill-model-prices`.
- **#236** evals sweep the roster (extends the bridge helper from decision 6).
- **#237** LangSmith provider attribution + TTFT under racing.
- **#238** aux calls + enrichment pass.
