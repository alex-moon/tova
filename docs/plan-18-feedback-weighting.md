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

## Ticket status (verified from the repo, 2026-09-11)

- Trunk `94b9fc5` contains only a plan doc for #18 and #17 work (PRs
  #22/#23). **No feedback code exists anywhere**: grep for
  `feedback|thumbs|upvote|modelMetricsStats` over `src/` and `docs/`
  matches nothing beyond this plan and #17's plan. Branch
  `feat/tv/18-feedback-weighting` is clean and ahead-of-main by zero
  commits. Not already done.
- GitHub issue #18 has **zero comments**, so this plan cannot be informed
  by discussion beyond the issue body; everything below is derived from
  the body plus repo inspection.
- Blocking check: dependency #17 is merged (`4ba6e5a`). No posted blocking
  reason; nothing here depends on #4.

## Decisions (each is taken _unconditionally_, not contingent on an open question)

1. **`feedback` subdocument on Message** — `{ value: 'up'|'down',
updatedAt: Date }` (one slot, not an array; revote overwrites = the
   issue's literal idempotence semantics). Matches #17's precedent of
   embedding analysis data on the message doc. No voter identity is
   stored: the issue asks for auth _enforcement_, not a per-user ledger,
   and a single overwrite slot cannot honor per-user votes anyway (a
   per-user stream of votes is a possible future ticket, not planned
   here).
2. **Revoting corrects the aggregate, never double-counts** — outvoting
   `up`→`down` does `$inc: { up: -1, down: +1 }`; re-clicking the same
   value does nothing to counters. Tested explicitly.
3. **Aggregation store is a Mongo collection, not in-memory** —
   `modelMetricsStats` documents keyed `(band, modelName)` with `{ up,
down }` counters and a minimal-query unique index for `$inc`-style
   upserts (`findOneAndUpdate ... { upsert: true }`). Survives restarts;
   router reads without scanning messages.
4. **Band = deterministic prompt metrics of the user turn, captured at
   route time, written onto the assistant message before save.** Concretely
   `routingBand` (string) on the assistant message, e.g.
   `medium|code`. Rationale for determinism (not `llm.technical`): the
   LLM classification is fire-and-forget _after_ the user message save
   (`chat.ts:54-58` while routing happens immediately after, `chat.ts:97`),
   so `metrics.llm.technical` is virtually always `null` at routing time —
   an LLM-based band would collapse to a single `null` key in practice.
   The issue's "high-technical" wording is treated as intent, not spec;
   whether to widen the band once #4/async classification can feed routing
   is raised in Open questions. A string key needs no migration to widen
   later.
5. **Router weighting is a perturbation, not a replacement** —
   `routeQuery(query, config, deps?)` gains a third optional argument (a
   small `{ getFitWeight(band, model): Promise<number> }` reader,
   defaulting to the real stats service) so unit tests inject stubs
   without Mongo. The empirical weight applies **only** on the
   `classifier-simple` / `classifier-complex` threshold path (the two
   deterministic rules and `classifier-error` stay untouched), and flips
   the choice only when the weight ratio between the two candidates
   exceeds a threshold (see task 4). The applied weight and tallies are
   appended to `reason` (e.g.
   `classifier-simple;feedback-weight:0.85:12/2`), matching #17's
   reasons-as-trace convention.
6. **Cold start neutral** — below MIN_SAMPLE = 5 tallies in a `(band,
model)` cell, weight is neutral (1.0), no flip, no reason suffix. Any
   read error in the stats service routes to the same neutral path: a
   stale/missing stats collection must never 500 a chat request.
7. **Auth + authorization at the route level** — `POST
/api/messages/:messageId/feedback` (new `src/server/routes/feedback.ts`,
   mounted next to chat) uses `authenticate` (401 unauthenticated) and
   authorization via the message's session: `Message` has no `userId`, so
   the handler looks up `{ sessionId, userId: req.user.id,
deletedAt: null }` in `Session` (403 foreign session, 404 unknown
   message id). `req.user.id` shape verified against `chat.ts:74/249`, so
   no confirmation needed at implementation time.
8. **Buttons support unvote** — clicking the active thumb again clears the
   vote (`DELETE /api/messages/:messageId/feedback`, per the issue-comment
   answer to Q1), clicking the other thumb overwrites; while a request is
   in flight both are disabled. Initially built overwrite-only; revised
   after the issue comment confirmed clearing is required.

## Critiqued assumptions (each with the honest risk attached)

- **The router is not a multi-candidate scorer.** The issue says "when the
  router scores candidate models", but `routeQuery` (`routerService.ts:20`)
  has exactly two candidates. v1 biases the binary choice; making the
  router a ranked catalog is a separate ticket. Risk of scope creep if the
  acceptance test is written before the router signature is settled —
  mitigated task-by-task below.
- **The router does not consume `metrics.llm` at route time.** There is no
  hook in `chat.ts` where the router sees analysed features, and every
  attempt to key the weight off LLM flags would read them before
  classification completes (`chat.ts:54-67` saves → routes → the
  classification lands later). Decision 4 follows from this; the possible
  widening is parked in Open questions **Q2** rather than baked into task
  1's field shape.
- **Two-tier parity of the aggregation key.** The turn-level band is
  derived from the _user_ message, but the feedback row and `modelName`
  live on the _assistant_ message; the two must join by construction (the
  band is written onto the assistant message at creation, decision 4),
  not re-derived from `sessionMessageIndex` parity inside the feedback
  handler (index computation is count-based and racy per plan-17's own
  admission, `chat.ts:16-19`).
- **Idempotence under concurrency.** Two quick revotes can interleave
  plain writes; counters are corrected by reading the _previous_ value in
  the same handler commit as the message write (`findOneAndUpdate` on the
  message, then a single `$inc` delta computed from before vs after). A
  truly guarded transaction is more machinery than needed here since the
  worst-case leak from exact double votes within a window is one tally.
- **Feedback for stale/foreign messages remains readable forever** — the
  feedback endpoint should not demand `metrics`, `modelMetricsStats` keys
  or any particular roll of the dice; only messageId existence + session
  ownership.
- **`status` of the modelMetricsStats design's correctness under
  preference-learning is a critique, not a plan.** A band with 12↑/3↓ does
  not prove the model was good on _this_ prompt; it may track reply
  quality correlates (length, topic) not routed features. That limitation
  is accepted (the issue frames it as an empirical multiplier, not
  attribution) and the reason string keeps tallies visible so drift is
  inspectable.
- **Client fetch correctness after reload** — the thumbs' value comes from
  the returned message's `feedback` field, already returned by
  `GET /sessions/:id` (`chat.ts:281-284`); optimistic local state updates
  on click and reconciles on reload. Unknown-state handling (message
  without feedback) renders no active thumb — just default disabled
  pair.
- **Spanish/unicode prompts:** the band is a string built from totals-when-guaranteed
  deterministic metrics (`computeDeterministicMetrics`) — no text
  parsing at feedback time beyond what #17 already holds safe; `lengthBucket`
  enumerates `short|medium|long` on the schema (`Message.ts:28`).

## Task checklist

Each item is a self-contained commit; none _starts_ on an open question.

- [x] 1. **Schema** — add to `Message`: `feedback: { value: {
 type: String, enum: ['up','down'] }, updatedAt: { type: Date } }`
      and `routingBand: { type: String }` (both sparse-optional; no
      migration needed for existing documents). In `chat.ts` (both
      endpoints), compute `routingBand` at route time from the user
      message's persisted deterministic metrics just after routeQuery
      (e.g. `${metrics.lengthBucket}|${metrics.codeIndicators?.fences > 0 ? 'code' : 'prose'}`) and persist it on the assistant message at creation.
      Test via the existing
      chat integration tests: assistant message carries
      `routingBand` after POST `/` and `/stream`, `feedback` is null.
- [x] 2. **Stats service** — new `src/server/services/modelMetricsStatsService.ts`
      with `recordFeedback(band, modelName, value, prevValue?)` and
      `getFitWeight(band, modelName)` returning `{ weight, ups, downs }`.
      Word on the contract: upsert `.findOneAndUpdate` of a unique
      `(band, modelName)` doc, `$inc` counters adjusted by the
      correction delta (decision 2). `getFitWeight` must be total: on
      read error or below MIN_SAMPLE (5) returns `{ weight: 1.0, ups: 0,
 downs: 0 }`; weight = `(ups + 1) / (ups + downs + 2)` — a
      Laplace-smoothed ratio so a brand-new band with 1↑/0↓ cannot
      immediately max out the weight.
- [x] 3. **Feedback route** — `POST /api/messages/:messageId/feedback`
      (`routes/feedback.ts`, mounted next to chat in the app's router
      list) with `authenticate`; body validation (400 on missing /
      non-`up|down` value); authorization via the message's session
      (decision 7); overwrite the message's `feedback` in the same
      handler and `recordFeedback` the corrected counters (decision 2),
      returning the updated message. Integration tests in
      `feedback.test.ts`: authed round trip, re-vote overwrite ups/
      downs corrected, 401 unauthenticated (from the
      `chat.permissions.test.ts` patterns), 400 bad value, 403 foreign
      session, 404 unknown message. Revised during critique: 400 for a
      vote on a user-role message, and a parallel
      `DELETE /:messageId/feedback` endpoint (clearing, per the issue
      comment on Q1).
- [x] 4. **Router weighting** — extend `routeQuery` signature to
      `routeQuery(query, config?, deps?)` where `deps.getFitWeight` reads
      `{ weight, ups, downs }` and `deps.band` is the deterministic band
      of the user turn. On the classifier tiebreak path, fetch weights
      for `(band, smallModel)` and `(band, largeModel)`; flip the choice
      when the rival-vs-chosen weight ratio exceeds the constant
      `FEEDBACK_FLIP_RATIO` (1.25 in v1, not a tunable); append
      `;feedback-weight:<w>:<ups>/<downs>` to `reason` only when the band
      has any tallies (cold start keeps a bare reason; decision 6).
      Unit tests in `routerService.test.ts` (stubbed deps, no Mongo):
      empty stats → identical to today's behavior; seeded tallies flip
      simple→large and complex→small both ways; sub-threshold ratio does
      not flip; deterministic rules and `classifier-error` stay
      untouched.
- [x] 5. **Client** — thumbs pair under assistant messages in
      `ChatWindow.tsx`: `onFeedback(messageId, value | null)` calls
      `POST /api/messages/:messageId/feedback` with `{ value }`, or
      `DELETE .../feedback` when the active thumb is clicked again
      (unvote). Buttons render from the message's persisted `feedback`
      field; while in flight both are disabled; type augment lives in
      the shared `App.tsx` `Message` interface. Client vitest in
      `ChatWindow.feedback.test.tsx`: click sends correct value,
      re-clicking the active thumb unvotes, pending request disables
      both buttons.
- [ ] 6. **Docs** — `docs/progress.md` entry on merge; one
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
  covered by the task 4 test seeding stats and asserting a different
  model choice.

## Open questions

No task in the checklist above depends on these; each has an implemented
default (decisions 4 and 8). They are questions _because the interaction
semantics of an opaque notion ("weights the model's fit") should be
confirmed on PR review_, not because the build is blocked.

- **Q1: Opt-out (clearing) semantics** — answered in issue comments
  2026-09-11: clearing **is** required, via `DELETE /path/to/message/vote`.
  _Built:_ `DELETE /api/messages/:messageId/feedback` sets
  `feedback.value` to null and decrements the previous value's counter;
  the UI clears on re-click of the active thumb.
- **Q2: Band key on LLM flags** — answered in issue comments: v2 will
  widen the band to include LLM-classified flags when the router can
  consume them (dependent on #4); v1 collects on the deterministic band
  only. _Built_: deterministic-only band (lengthBucket × code/prose),
  confirmed correct.
- **Q3: Single overwrite slot / no voter identity** — answered in issue
  comments: confirmed ("impossible for a user to vote twice", unvote must
  work after re-login / other devices — both true of the session-
  ownership check without stored voter identity). _Built_: as decided.

New questions raised during the critique (unanswered in the issue so far):

- **Q4: Retry-equivalence of cleared votes in the aggregate** — a cleared
  vote is deleted from the tally; the cell loses the sample entirely (a
  flip-down then unvote returns the model's row to its pre-vote state).
  Confirm there is no requirement to remember "this message received a
  vote and was retracted" for weighting purposes.
- **Q5: Legacy messages without `routingBand`** — assistant messages
  created before this feature carry no band; their votes persist on the
  message but are silently skipped by the aggregate (empty-band guard in
  the stats service). Fine for bootstrapping; confirm no backfill is
  wanted.
- **Q6: Concurrent revote/clear counter skew** — the counter correction
  reads `feedback.value` before the write; two requests on the same
  message crossing in that window can leave a counter off by one. The
  plan accepted a one-tally worst case for revotes; DELETE adds the same
  exposure to clears. A transactional read-back would fix it; currently
  accepted as within the plan's stated tolerance.
- **Q7: Threshold constant `FEEDBACK_FLIP_RATIO = 1.25`** — chosen so a
  genuine split of community opinion (e.g. 8↑/5↓) cannot flip routing
  alone; only strongly lopsided cells can. Confirm 1.25 is the intended
  aggressiveness before LangSmith makes it visible.
