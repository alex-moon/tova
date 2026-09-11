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
   on the message document (`feedback` subdocument alongside `metrics`),
   plus unvote (`DELETE`) per the Q1 answer.
2. **Aggregation** — a `modelMetricStats` Mongo collection of
   per-`(routingBand, modelName)` up/down tallies, e.g.
   `medium|code + openai/gpt-oss-20b → 12↑/3↓`.
3. **Weighting** — when routing a new message, factor these empirical fit
   scores into the model choice on the classifier tiebreak path, and put
   the applied weight in the routing reason (LangSmith, #5, can surface it).

## Ticket status (verified from the repo, 2026-09-11)

- Implementation **exists and is tested on this branch** (`f98398d`,
  `5e06840`): `src/server/routes/feedback.ts` (POST + DELETE),
  `src/server/services/modelMetricsStatsService.ts`,
  `routingBand` persisted in `chat.ts`, weighting in `routerService.ts`,
  client thumbs in `ChatWindow.tsx`. Jest/vitest suites for the new code
  pass (31 targeted tests re-run green today). Not already merged — the
  branch is unpushed-to-main, PR pending.
- **Remaining work:** task 6 only (progress log entry + a
  `scripts/mongo.ts` inspection snippet), then PR/ship.
- Blocking check: #17 merged (`4ba6e5a`); all issue-comment Q&A resolved
  (Q1–Q7); nothing depends on #4. Not blocked.

## Resolved questions (from issue comments — now part of the design, not open)

- **Q1 — Clearing:** required. Implemented as
  `DELETE /api/messages/:messageId/feedback` (`feedback.ts:76`): sets
  `feedback.value` to null and decrements the previous value's counter;
  idempotent. Alex explicitly preferred DELETE over a PATCH-with-null.
- **Q2 — Band key:** v1 collects on the deterministic band
  (`lengthBucket × code|prose`), which is what's routed on; widening to
  LLM-classified flags is a v2/#4 concern ("we are just collecting"),
  a non-migrating string-key change.
- **Q3 — Voter identity:** none stored; auth enforced (401/403) but the
  single overwrite slot means any device/re-login can unvote, which is
  what Alex wanted ("impossible for a user to vote twice"). Per-user vote
  history is not built; Mongo shape for it has "no strong opinions".
- **Q4 — Retracted votes vanish from tallies:** confirmed. `clearFeedback`
  decrements; no memory that a vote existed and was retracted.
- **Q5 — Legacy messages without `routingBand`:** confirmed fine. Their
  votes persist on the message (`feedback.ts` still round-trips them) but
  are skipped by the aggregation (empty-band guard,
  `modelMetricsStatsService.ts:31`); no backfill (DB may be nuked anyway).
- **Q7 — Flip aggressiveness:** `FEEDBACK_FLIP_RATIO = 1.25` accepted for
  now ("community is one user"); fancier weighted-agreement statistics
  deferred, no change planned in this ticket.

## Decisions (implemented)

1. **`feedback` subdocument on Message** — `{ value: 'up'|'down'|null,
updatedAt }` (one slot; revote overwrites; DELETE clears to `null`).
   Sparse-optional on the schema, no migration.
2. **Revoting/unvoting corrects the aggregate, never double-counts** —
   the handler reads `prevValue` before the write and emits an adjusted
   `$inc` (`recordFeedback`/`clearFeedback`). Same-value re-click is a
   tracked no-op for counters. Stats failure never fails the vote
   (caught + logged, `feedback.ts:59-63`).
3. **Aggregation store is Mongo, not in-memory** — `ModelMetricStat`
   collection keyed `(band, modelName)` with a unique index,
   `findOneAndUpdate … { upsert: true }`. Survives restarts; router reads
   without scanning messages.
4. **Band = deterministic prompt metrics of the user turn**, computed in
   `chat.ts` (`buildRoutingBand`) from the persisted user-message metrics
   just after routing, written onto the assistant message at creation.
   `metrics.llm.technical` is fire-and-forget _and post-save_ (`chat.ts`
   classification lands after the route call), so an LLM-based band
   collapses to one `null` key in practice — verified from the code flow,
   confirmed by the Q2 answer.
5. **Weighting is a perturbation, not a replacement** — `routeQuery`
   takes an optional deps object (`{ band, getFitWeight }`) so unit tests
   inject stubs without Mongo. Applies **only** on the
   `classifier-simple`/`classifier-complex` tiebreak path; deterministic
   rules and `classifier-error` untouched. Weight flips the choice only
   when `rivalWeight / chosenWeight > FEEDBACK_FLIP_RATIO (1.25)`. Reason
   string gains `;feedback-weight:<w>:<ups>/<downs>` whenever the band has
   any tallies.
6. **Cold start and error neutrality** — below `MIN_SAMPLE = 5` tallies
   (or on read error) weight is neutral 1.0, no flip. Weight is
   Laplace-smoothed (`(ups+1)/(ups+downs+2)`) so one vote cannot max out
   an empty cell. A broken stats collection must never 500 a chat
   request.
7. **Auth + authorization at the route level** — `authenticate` (401);
   ownership via `Session.exists({ _id: sessionId, userId: req.user.id,
deletedAt: null })` (403); unknown/invalid id → 404; non-assistant
   message → 400 (critique addition). No voter identity stored (decision
   3 of Q3 above).
8. **Client UX** — thumbs under assistant messages in `ChatWindow.tsx`;
   active-thumb re-click sends DELETE (unvote); other thumb overwrites
   with POST; both disabled while in flight; state reconciles from the
   message's persisted `feedback` on reload (GET sessions already returns
   it).

## Critiqued assumptions (honest risks, standing)

- **The router is a binary choice, not a scorer.** The issue says
  "scores candidate models"; in reality there are two candidates. v1
  biases the pairwise pick; no ranked-catalog work is planned here.
- **Two-tier parity of the aggregation key:** the band derives from the
  _user_ turn while `modelName` lives on the _assistant_ message; they
  join only by construction (band written at assistant-message creation,
  `chat.ts:112/142`), not by re-derivation (index parity is racy per
  plan-17). If `routingBand` persistence ever breaks, tallies silently
  lose samples — this is visible in the chat tests (task 1).
- **Concurrent revote/clear counter skew is real and accepted:** the
  prevValue read and the message write are not transactional; two
  crossing requests can leave a counter off by one. Worst case per the
  plan's tolerance: one tally. Alex's Q6 answer ("per-user votes solves
  this") is read as accepting the skew now, with per-user vote storage as
  the eventual structural fix — see **NQ1** (this ticket does not build
  per-user storage).
- **Aggregation is preference-correlation, not attribution:** a cells'
  12↑/3↓ may track reply-quality correlates (length, topic) rather than
  the routed features. Accepted per the issue framing (empirical
  multiplier); tallies stay visible in the reason string so drift is
  inspectable.
- **Stale/foreign/legacy messages remain** readable and votable forever:
  the endpoint demands only exact-id existence + session ownership;
  missing band/modelName just no-ops the stats side.
- **Band construction is locale-safe:** derived from
  `computeDeterministicMetrics` (length bucket enum + code-fence check);
  no text parsing at feedback time. Unvotable messages (user-role)
  rejected with 400.
- **Acceptance criterion "router decisions demonstrably shift"** is
  satisfied by unit tests on the tiebreak path with stubbed stats
  (flip both ways, sub-threshold no-flip, deterministic paths untouched),
  not by a live model swap. A live demonstration would require Groq calls
  and seeded data — out of scope for CI.

## Task checklist

- [x] 1. **Schema + band persistence** — `Message.feedback`
      (`{ value: 'up'|'down'|null, updatedAt }`, sparse-optional) and
      `Message.routingBand: string`. `chat.ts` computes the band from the
      persisted deterministic metrics just after `routeQuery` and sets it
      on the assistant message at creation (both `/` and `/stream`).
      Covered by `routes/chat.test.ts` extensions.
- [x] 2. **Stats service** — `src/server/services/modelMetricsStatsService.ts`:
      `recordFeedback(band, modelName, value, prevValue)` with corrected
      `$inc` upserts, `clearFeedback` for DELETE, and total
      `getFitWeight(band, modelName)` → `{ weight, ups, downs }` (Laplace
      smoothing; MIN_SAMPLE 5; error → neutral). Unit tests beside it.
- [x] 3. **Feedback routes** — `routes/feedback.ts`, mounted in
      `index.ts`: `POST /:messageId/feedback` (authenticate; 400 bad or
      missing value; 400 user-role message; ownership via session; stats
      failure never fails the vote) and `DELETE /:messageId/feedback`
      (idempotent clear; decrements prev counter; no-op when nothing
      stored). Integration tests: 200/400/401/403/404 patterns from
      `chat.permissions.test.ts`, overwrite correction, clear correction.
- [x] 4. **Router weighting** — `routeQuery(query, config?, deps?)`; on
      the classifier tiebreak only, fetch weights for both models with
      the turn's band, flip on ratio > 1.25, append the
      `feedback-weight:` reason suffix. Unit tests: empty stats = today's
      behavior; flips both directions; sub-threshold no-flip;
      deterministic/error paths untouched.
- [x] 5. **Client** — `ChatWindow.tsx` thumbs with unvote-on-reclick and
      in-flight disable; vitest `ChatWindow.feedback.test.tsx`.
- [x] 6. **Docs** — `docs/progress.md` entry on merge (deferred to merge, as
      specified); one `scripts/mongo.ts` snippet for inspecting
      `modelMetricStats`. Mongoose's default collection name for
      `ModelMetricStat` is `modelmetricstats` (lowercase plural). Verified
      against the live local DB with a seeded row, matching the unit-test
      expectation (up=2, down=1 → weight 0.6). Rows with fewer than
      `MIN_SAMPLE = 5` votes are ignored by the router, not by this query.

### `scripts/mongo.ts` inspection snippet for `modelMetricStats`

```text
# Per-(band, model) tallies with totals and the Laplace-smoothed fit weight
# that getFitWeight() computes: (up + 1) / (up + down + 2).
npx tsx scripts/mongo.ts 'db.collection("modelmetricstats").find({}, { _id: 0, sort: { up: -1 } }).toArray()'

# Aggregated view: total votes and smoothed weight per row.
npx tsx scripts/mongo.ts 'db.collection("modelmetricstats").aggregate([
  { $project: { _id: 0, band: 1, modelName: 1, up: 1, down: 1,
    total: { $add: ["$up", "$down"] },
    weight: { $round: [ { $divide: [ { $add: ["$up", 1] }, { $add: ["$up", "$down", 2] } ] }, 3 ] } } },
  { $sort: { total: -1 } }
]).toArray()'
```

No task depends on an open question.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`
- `npm --prefix src/client run lint` (client changes in task 5)
- `npm run format:check`
- `npm run ci` as the final gate.
- Targeted suites re-run green on 2026-09-11 (executor's verification):
  `routerService.test.ts`, `feedback.test.ts` — 31 passing.

## Acceptance criteria (from the issue)

- Feedback round-trips for authed users; 401 for unauthenticated. ✔
  (route tests)
- Thumbs show their current state after reload. ✔ (persisted field +
  client tests)
- Router decisions demonstrably shift with accumulated feedback. ✔
  (task 4 unit tests on the tiebreak path)

## Open questions

- **NQ1 — Meaning of the Q6 comment ("yes, per-user votes solves this"):**
  Alex's answer reads either as "the one-tally skew is accepted, and
  per-user votes would be the eventual fix" (current implementation) or
  as "build per-user vote storage now". Structurally different: per-user
  storage replaces the single `feedback` slot with a votes ledger, which
  touches the client, the route, the stats correction, and #17's
  precedent. This ticket ships the single-slot design per the rest of the
  Q3 answer ("no strong opinions" on storage) and needs explicit
  confirmation only if per-user storage is wanted in the near term.

Nothing else remains open: Q1–Q5 and Q7 are each confirmed in the issue
comments and folded into the design above.

## Critique pass 2 (2026-09-11, CI green after changes)

Full `npm run ci` was already green before this pass; the changes below
are hardening + documented behavior, and CI was re-run green after them
(107 server / 16 client tests).

- **Fixed — `recordFeedback` guard parity:** it checked the band but not
  `modelName` (`clearFeedback` checks both), so a band-bearing message
  with no `modelName` would upsert a junk `modelName: ''` stat row. Now
  skips on either blank; test added.
- **Fixed — empty-band short-circuit in `getFitWeight`:** legacy/featureless
  turns pass no band; previously every classifier-path chat turn issued
  two `ModelMetricStat.findOne` queries anyway. Now returns neutral
  immediately.
- **Documented edge (test):** an empty rival cell (neutral 1.0) _can_ flip
  routing when the chosen cell has ≥ MIN_SAMPLE tallies and a strongly
  negative ratio (e.g. 0↑/5↓ → weight 0.143, rival 0 data → 1.0).
  Deliberate "rival can't be worse" semantics; pinned by a unit test and
  the reason string `;feedback-weight:1.00:0/0` makes it inspectable in
  LangSmith (#5). If this should not flip, the MIN_SAMPLE gate must apply
  to the rival before comparing — say so and it's a two-line change.
- **A11y:** thumbs now carry `aria-pressed`, matching the visible
  active-thumb state; client test added.
- **Standing, accepted (no change):** the per-message one-tally
  concurrency skew (NQ1 thread), the client's fail-silent feedback error
  path (thumb state merely stays stale, no revert needed since state is
  bound to the server-confirmed message), and the existence-probe 404/403
  distinction on unknown message ids (auth-gated and consistent with the
  chat permission tests). No open questions raised here.
