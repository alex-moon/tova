# Plan — feat/tv/18-feedback-weighting (thumbs up/down that weights model-vs-metrics fit)

GitHub issue: https://github.com/alex-moon/tova/issues/18

## Motivation

This ships the user-facing half of the routing-correlation story started in
#17 (per-message prompt metrics, merged via PR #23). Today the router
(`src/server/services/routerService.ts`) picks between `ROUTER_SMALL_MODEL`
and `ROUTER_LARGE_MODEL` with two deterministic rules plus a guard-model
"simple|complex" classification, but nothing ever learns from whether a
reply was actually good. Users have no way to say so.

This ticket adds:

1. **Feedback capture** — thumbs up/down on assistant messages, persisted
   on the message document (`feedback` subdocument alongside `metrics`).
2. **Aggregation** — a `modelMetricsStats` Mongo collection of
   per-`(modelName, metric-band)` up/down tallies, e.g.
   `openai/gpt-oss-20b + technical + long prompt → 12↑/3↓`.
3. **Weighting** — when routing a new message, factor these empirical fit
   scores into the model choice alongside the existing heuristics, and log
   the applied weight in the routing reason (LangSmith, #5, can surface it).

## Current state (verified from the repo, 2026-09-11)

- Dependency check: #17 is done and merged (PRs #22/#23, branch
  `fix/tv/17-prompt-metrics` merged to main; head commit `4ba6e5a`).
  No blocking reason remains: `DEEPINFRA_API_KEY` route unblocks #4
  independently; nothing here depends on #4.
- No feedback code exists anywhere: grep for `feedback|thumbs|upvote|
  modelMetricsStats` over `src/` and `docs/` returns only #17's plan doc
  (as forward references). Not already done.
- `src/server/models/Message.ts` — schema has `sessionId`, `role`,
  `content`, `modelName`, `timestamp`, `metrics` (deterministic + `llm`
  + `llmSkipReason`). **No `feedback` field.** Messages are create-only
  except for the post-save LLM classification update (proof the
  `findByIdAndUpdate` pattern works).
- `src/server/routes/chat.ts` — all routes use `authenticate`
  (`src/server/middleware/auth.ts`); user identity available as
  `req.user` (check exact shape when implementing — see Open questions).
  Endpoints: `POST /` and `POST /stream` (persist user + assistant
  messages with metrics), `GET /sessions`, `GET /sessions/:id`.
- `routerService.routeQuery(query)` takes only the query string and
  returns `{ model, reason }`. It does **not** consume `metrics.llm`
  today; there is currently no multi-candidate scoring — the router it
  picks between exactly two configured models via rules/classifier.
- Assistant messages already carry `modelName` at save time
  (`chat.ts`), so the aggregation band key is available where the
  feedback endpoint runs.
- Client: `src/client/src/components/ChatWindow.tsx` renders messages
  (`messages.map`, line ~113); assistant bubbles already show
  `msg.modelName` when present. `Message.vue`-equivalent type lives in
  `src/client/src/types/`; history endpoint is
  `GET /sessions/:id` (which returns messages with metrics).
- Tests: Jest + `MongoMemoryServer` (`src/server/test/setup.ts`);
  integration patterns in `chat.test.ts` / `chat.stream.test.ts` /
  `chat.permissions.test.ts`; unit pattern in `routerService.test.ts`.
  Client tests run with vitest.

## Decisions so far

1. **`feedback` subdocument on Message** — `{ value: 'up'|'down',
   updatedAt }` (one slot, not an array; revote overwrites = idempotent,
   per the issue). Matches #17's precedent of embedding analysis data on
   the message doc.
2. **Aggregation store is a Mongo collection, not in-memory** —
   `modelMetricsStats` with documents keyed on `(modelName, band)` and
   `{ up, down }` counters, updated with `$inc` on each feedback write.
   Survives restarts and lets the router read without scanning messages.
3. **Metric band from the *user* prompt's deterministic metrics** of the
   turn, not the assistant reply — the issue's intent ("model's fit for
   the metrics collected per message") and #17's rationale are about
   correlating with the *prompt*. Band composition is an open question
   (below); the likely v1 band is `llm.technical` boolean ×
   `lengthBucket`, both already persisted on the user message.
4. **Router consumes stats via a second scoring pass, additive not
   destructive** — the existing two-tier rules remain the skeleton; the
   empirical weight *perturbs* the choice only when the deterministic
   and classifier tiers don't strongly decide, and the applied weight is
   appended to `reason` (e.g. `classifier-simple;feedback-weight:0.6:16/2`
   — weight:ups/downs). Kept simple so it cannot regress baseline
   routing until the stats are meaningful.
5. **Cold start** — below a minimum sample count (MIN_SAMPLE, default
   5) in a band, the weight is neutral (1.0) and omitted from the reason.
6. **Auth enforcement at the route level** — `POST
   /api/messages/:messageId/feedback` returns 401 when unauthenticated
   and 404/403 for messages the user can't see; porcelain over the
   existing `authenticate` middleware.

## Critiqued assumptions

- **`routeQuery` currently scores only two models.** The issue talks
  about "scoring candidate models", but the codebase has no candidate
  list beyond `smallModel`/`largeModel`. The v1 weighting therefore
  biases the *choice between the two*, not a ranked catalog. Making the
  router multi-candidate is out of scope (would be its own ticket).
- **Revote idempotence is overwrite semantics at the message doc** — but
  the aggregate counters must not double-count: i.e. outvoting from `up`
  to `down` must `$inc` down and `$inc` up `-1`. This is handled in the
  single commit where both sides land; tested.
- **Where the band comes from in the feedback endpoint:** the feedback
  is on the *assistant* message but the band comes from the *user*
  message of the same turn — correlate via `sessionId` +
  `sessionMessageIndex` (assistant index = user index + 1) or store the
  band on the assistant message at routing time. The second is simpler
  and race-free (the router already knows the features at route time);
  this plan prefers writing the band onto the assistant message when it
  is saved. Needs one look at the exact save flow to confirm; see
  task 1.
- **Feedback from unauthenticated users:** history GET is behind
  `authenticate`; there is no anonymous message exposure, so the 401
  acceptance criterion is satisfied by route-level middleware alone.
- **Stats service error handling:** a missing/stale stats document must
  never break routing — read failures return neutral weight (same
  cold-start path).
- **Client state after reload:** thumbs render their value from the
  message `feedback` field that already comes back in
  `GET /sessions/:id` messages — no extra fetch per message needed.
- **Spanish/unicode prompts:** band extraction uses already-computed
  deterministic metrics, which are total functions (guaranteed in #17);
  null LLM flags degrade to a `null` band segment and simply produce a
  different aggregation key — fine.

## Task checklist

Each item is a small, self-contained commit.

- [ ] 1. **Schema + band capture**: add `feedback: { value:
      'up'|'down', updatedAt: Date }` to `Message`; also persist
      `routingBand` (string) on the assistant message at save time in
      both chat endpoints (derived from the user message's metrics that
      the router already had; e.g. `technical:true|long`). Unit-tested
      via the existing chat integration tests (assert the field).
- [ ] 2. **Feedback route**: `POST /api/messages/:messageId/feedback` in
      a new `src/server/routes/feedback.ts` (mounted next to chat), with
      `authenticate`: validates `value`, overwrites the subdocument,
      updates `modelMetricsStats` (`$inc`) in the same handler,
      401/404/400 semantics. Integration tests: authed round-trip,
      revote overwrite + counters not double-counted, 401 unauthed, 400
      bad value, 404 foreign/message-less (pinned to the existing
      permissions test style).
- [ ] 3. **Stats service**: `src/server/services/modelMetricsStats.ts` —
      `recordFeedback(band, model, value)` and
      `getFitWeight(band, model)` with the MIN_SAMPLE neutral fallback
      (`getFitWeight` must also be total on read errors). Unit tests
      with MongoMemoryServer: cold start neutral, aggregation math,
      revote correction.
- [ ] 4. **Router weighting**: extend `routeQuery` (new optional arg or
      a small injected stats reader so unit tests don't need Mongo) so
      that on the `classifier-simple`/`classifier-complex` tiebreak path
      the fit weight of both candidate models is compared and a large-enough
      empirical preference flips the choice; append the applied weight +
      tallies to `reason`. Test seeding both bands and asserting the
      *different model choice* (the issue's acceptance criterion). Also
      assert no behavior change when stats are empty.
- [ ] 5. **Client**: thumbs button pair on assistant messages in
      `ChatWindow.tsx` (subtle disabled-pending state, opt-out = click
      again to clear? — see Open questions), POST via the existing
      lib/fetch helper, and render persisted state from the message
      object. Client vitest covering render + click + error toast.
- [ ] 6. **Docs**: `docs/progress.md` entry on merge; one
      `scripts/mongo.ts` snippet for inspecting `modelMetricsStats`.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`
- `npm --prefix src/client run lint` (client changes in task 5)
- `npm run format:check`
- `npm run ci` as the final gate.

## Acceptance criteria (from the issue)

- Feedback round-trips for authed users; 401 for unauthenticated.
- Thumbs show their current state after reload.
- Router decisions demonstrably shift with accumulated feedback —
  covered by a test seeding stats and asserting a different model choice.

## Open questions

No planned task *starts* on an open question, but task 5's final shape
depends on two of them; both come with a default that can be implemented
unilaterally and revised on PR review:

- **Opt-out behavior of the buttons** — does clicking the active thumb
  again *clear* the feedback, or is feedback only ever overwritten
  up↔down (issue says `{ value: 'up'|'down' }` with revote-overwrite and
  doesn't mention clearing)? *Default:* overwrite-only (matches the
  issue literally, no DELETE endpoint); raise on the PR so it is a
  decision, not a surprise.
- **Exact band key for aggregation** — the issue's example band
  ("high-technical + long prompt") implies LLM-classified `technical`
  plus `lengthBucket`, but `metrics.llm.technical` may be `null`
  (skip-gated or parse-failed prompts) and the classification model has
  not been production-swapped (that rides on #4). *Default:* band =
  `technical:true|false|null` × `lengthBucket`, with `null` aggregating
  into its own key; the shape can be widened later without a migration
  because keys are strings.
- **Which user a feedback row belongs to** — the issue says
  "authenticated" but doesn't ask to store *who* voted, and my read of
  `req.user`'s shape (`authenticate` middleware) needs confirming
  during task 2. *Default:* enforce auth, don't store the voter (single
  overwrite slot can't honor per-user votes anyway).
