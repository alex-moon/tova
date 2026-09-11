# Plan — fix/tv/17-prompt-metrics (per-message prompt metrics)

GitHub issue: https://github.com/alex-moon/tova/issues/17

## Motivation

We want to understand **why** the router picks the model it picks, and later,
**whether that choice was right** (the upcoming feedback ticket will consume
these). Today, the router (`src/server/services/routerService.ts`) decides with
deterministic rules plus a guard-model pass, but nothing is recorded about the
_prompt itself_. The router only persists the outcome (`modelName`) on the
assistant message; the message documents carry no features.

This ticket collects a set of per-message metrics and persists them alongside
each message document in MongoDB, so future analysis (and eventually feedback)
can correlate routing decisions with prompt characteristics.

## Current state (verified from the repo)

- `src/server/models/Message.ts` — schema has `sessionId`, `role`, `content`,
  `modelName`, `timestamp`. No `metrics` field.
- Messages are created inline in `src/server/routes/chat.ts`:
  non-streaming at :56 (user) / :86–:92 (assistant); streaming at :130 (user) /
  :193–:199 (assistant). Messages are create-only today — never updated after
  save.
- LLM single-prompt patterns to mimic exist in `routerService.ts:49–72`
  (guard classifier, env-configurable `allam-2-7b`) and
  `titleService.ts:13` (`generateChatTitle`, try/catch fallback).
- No structured-output (JSON mode) calls exist anywhere; the router parses
  free text. No cache layers exist. No prompt-metrics code exists at all.
- Streaming flow: user message saved (:135) → `routeQuery` (:138) → SSE
  stream accumulated (:171–183) → assistant message saved (:199). Both
  endpoints `await` message saves. Insertion point for fire-and-forget work:
  right after each user-message `save()`.
- The chat-history fetch is `.limit(10)` (`chat.ts:69, 143`) — see the note
  in _Critiqued assumptions_: it cannot be used to derive a session-wide
  message index.
- Tests: Jest + ts-jest with `MongoMemoryServer` setup
  (`src/server/test/setup.ts`); closest patterns are
  `src/server/services/routerService.test.ts` (unit) and
  `src/server/routes/chat.test.ts` / `chat.stream.test.ts` (integration,
  mock the Groq client). `chat.permissions.test.ts` also exists.
- Models used are env-driven: `ROUTER_GUARD_MODEL` (defaults `allam-2-7b`)
  and `ROUTER_SMALL_MODEL` in `routerService.ts`.

## Decisions so far

1. **`metrics` subdocument** on `Message` (an embedded object, not a separate
   collection) — matches the issue's suggestion and keeps a message + its
   features in one document.
2. **Deterministic metrics** are computed synchronously in a pure TS module
   (no deps, no I/O) and attached _before_ `.save()` — zero added latency and
   no post-hoc update needed for them. Applied to both user and assistant
   messages (assistant content is final at save time).
3. **LLM-classified dimensions** run post-save, fire-and-forget, as a second
   `Message.findByIdAndUpdate(_id, { $set: { 'metrics.llm': ... } })` —
   a) nothing is added to first-token latency; b) a failed classification
   never breaks the chat request (errors logged, dimensions remain `null`).
   User messages only (see Open questions).
4. **One cheap classification call per user message** using the guard/small
   model path, asking for structured flags, parsed defensively as JSON with
   fallback to nulls (no reliance on Groq JSON mode — see Open questions).
5. **No cross-request caching** of classification results (no cache infra
   exists; building one is out of scope for this ticket).
6. Prompt-shaping helpers (stopword list, syllable heuristic) live inline in
   the pure module — no dependency added.
7. **Two counters stored instead of one** to de-risk the indexing-semantics
   question: `sessionMessageIndex` (count of _all_ prior messages in the
   session at write time) and `sessionUserMessageIndex` (count of prior
   _user_ messages). Both are cheap and preserve either interpretation
   permanently — the Open question only decides which one the future router
   work should read, not the schema.

## Critiqued assumptions (every current assumption, challenged)

- **"Index from history length we already fetch" — WRONG.** History is
  `Message.find(...).limit(10)`; a session with >10 messages would yield a
  capped, wrong index. Fix: compute the index with
  `Message.countDocuments({ sessionId })` distinct from the history query.
- **Count-based indices are racy under concurrency.** Two turns landing in
  the same session at the same moment can produce duplicate indices
  (both `countDocuments` before either save). Accepted risk: metrics are
  analytical data, not keys; a mismatched index is harmless for analysis.
  Documented here rather than "fixed" with a transaction.
- **`countDocuments` adds a round-trip per save.** Real but small; it
  replaces nothing and is one indexed-by-sessionId count query. Accepted.
  If it ever matters, it can become a `$inc`-able counter later.
- **Defensive JSON parsing may yield all-null flags.** The whole LLM
  classification could be useless in practice if the guard model can't emit
  parseable flags. Mitigation is built in (nulls on any failure, logged);
  quality is untested — see Open questions. The ticket ships the fallback
  path regardless.
- **Fire-and-forget updates during Jest runs.** A background promise can
  outlive the request handler the test asserts on, causing flaky tests. The
  integration tests must deterministically await completion — the service
  returns the promise; `chat.ts` ignores it, tests `await` it (via a flush
  after the response, e.g. by driving the mocked classify promise).
- **Dot-notation update must match the schema.** `updateById(_id,
{ $set: { 'metrics.llm': x } })` only works if the nested paths exist in
  the schema (they will, after task 1). Use `$set` explicitly.
- **Stopword/imperative/syllable heuristics are English-only.** Fine for a
  first pass; explicitly not claimed to work for other scripts (syllable
  count is nonsense for CJK). Documented in the module's doc comment.
- **`avgWordLength` and `syllableEstimateAvg` on empty/null content.** All
  modules must return 0/defaults, never NaN or throw (tested in task 3).

## Task checklist

Each item is a small, self-contained commit.

- [x] 1. **Model field**: add optional `metrics` subdocument to
      `Message.ts`. Deterministic part: `wordCount`, `charCount`,
      `lengthBucket` short|medium|long, `avgWordLength`,
      `syllableEstimateAvg`, `codeIndicators` `{ fences, backticks,
 codeTokenCount }`, `stopwordRatio`, `sessionMessageIndex`,
      `sessionUserMessageIndex`, `hasQuestionMark`, `hasImperative`.
      Nullable LLM part: `emotional`, `technical`, `abstract`, `sentiment`
      (positive|negative|neutral|null), `openEnded`. All LLM fields
      nullable with explicit `default: null` so queries filter predictably.
- [x] 2. **Deterministic metrics module**
      `src/server/services/promptMetrics.ts`: pure functions, no deps, no
      I/O; computes everything in item 1's deterministic section _except_
      the two session indices (need DB context). Vowel-cluster syllable
      heuristic; imperative check = first word is in a small known-verb
      list, case-insensitive; `codeIndicators` counts markdown fences,
      inline backtick pairs, and code-ish tokens (`{}`, `=>`, keywords);
      `lengthBucket` derived from `wordCount` threshold constants. Every
      function total (handles empty string, whitespace-only, unicode).
- [x] 3. **Unit tests** `promptMetrics.test.ts` following
      `routerService.test.ts` style: counts, buckets, code detection,
      stopword ratio, question/imperative detection; edges: empty string,
      whitespace-only, unicode text, long code block, all-zero guards
      (no division-by-zero).
- [ ] 4. **Wire deterministic metrics into persistence** in `chat.ts`:
      compute `computeDeterministic(content)` and build the indices with
      two `countDocuments({ sessionId, role })`-style queries (added
      _before_ the first `.save()` so they count priors only), attach to
      both user and assistant messages in both streaming and
      non-streaming paths. Keep the two count queries parallel
      (`Promise.all`) to avoid serializing them. Update
      `chat.test.ts` / `chat.stream.test.ts` expectations.
- [ ] 5. **LLM classification service** `classifyPromptDimensions(content)`
      in `src/server/services/metricsService.ts`: single call to the
      guard/small model via a prompt that returns five binary/simple
      flags, parsed defensively (extract first JSON-looking object;
      tolerate fences; unknown value = null per flag); on any throw
      return all-nulls (mirroring `titleService` error handling); returns
      the update object **and the promise** so tests can await.
- [ ] 6. **Wire classification post-save, fire-and-forget**: after each
      user-message save (both endpoints), call the service and persist via
      `findByIdAndUpdate` with `$set` on `metrics.llm`; `.catch` logs;
      never awaited, never throws into the request path. Assistant
      messages are _not_ classified (see Open questions).
- [ ] 7. **Integration tests** in `chat.test.ts` / `chat.stream.test.ts`
      with the existing mocked Groq client: a) every new user and
      assistant turn gets deterministic metrics filled with a
      session-correct index; b) LLM update lands on success (await the
      captured classify promise, then re-fetch the message); c) LLM
      failure leaves `metrics.llm` nulls and the chat response
      unaffected; d) indices increase across 12 turns in one session
      (asserts the >10-message history cap is not leaked into indices).
- [ ] 8. **Document**: short section in `docs/overview.md` + a
      `docs/progress.md` log entry on merge, with a `scripts/mongo.ts`
      snippet to inspect metrics.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`
- `npm --prefix src/client run lint` only if client code changes (not planned)
- `npm run ci` as the final gate.

## Acceptance criteria (from the issue)

- Every new user/assistant turn gets its `metrics` subdocument filled
  (deterministic part for both roles; LLM part for user messages).
- Deterministic metrics are covered by unit tests.
- No visible latency added to first token (classification is post-save,
  fire-and-forget).

## Open questions

Nothing depends on an open question; each has a chosen default that ships.

- **Does the small/guard model reliably emit parseable flags?** We have no
  structured-output precedent. Plan 5 assumes a plain completion parsed
  defensively. If quality proves poor, options: switch
  `metricsService` to `ROUTER_SMALL_MODEL` (one-line env change), or add
  Groq `response_format` JSON mode (in-ticket scope, but untested).
- **Should assistant messages get LLM-classified?** Cost: one extra call
  per assistant turn; benefit unclear (the router routes on user prompts).
  Default: user-only, unless reviewers object.
- **Guard vs small model default**: 5 flags in one call on the guard model
  is untested. Fallback is nulls either way; switching is env-only.
- **Which index the future router reads**: `sessionMessageIndex` (all
  roles) vs `sessionUserMessageIndex`. Both are stored; the consumer
  decides later — no data is lost under either interpretation.
- **Backfill of existing messages**: out of scope; issue only requires
  forward-going fills for new turns.
