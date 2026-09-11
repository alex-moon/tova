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

Note: this section was written at the start of the branch, before
implementing tasks 1–9; it is kept as the audit trail of what the branch
found. Tasks 1–9 are now implemented and verified (79 tests pass; `npm
run ci` green); task 10 is the only open item.

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
   User messages only (confirmed by alex-moon — see
   _Decisions since the first pass_).
4. **One cheap classification call per user message** using the guard/small
   model path, asking for structured flags, parsed defensively as JSON with
   fallback to nulls (no reliance on Groq JSON mode — see Open questions).
5. **No cross-request caching** of classification results (no cache infra
   exists; building one is out of scope for this ticket).
6. Prompt-shaping helpers (stopword list, syllable heuristic) live inline in
   the pure module — no dependency added.
7. **One counter stored** (`sessionMessageIndex`, count of _all_ prior
   messages in the session at write time). PR review feedback: the two
   candidate indices are analytically equivalent in the ballpark, so one is
   sufficient; `sessionUserMessageIndex` was dropped from the schema.

## Critiqued assumptions (every current assumption, challenged)

- **`allam-2-7b` can classify prompts** — DOUBTED (and now by alex-moon
  too). It was chosen by mirroring `routerService`'s guard path, but
  neither this service nor anywhere else in the repo has evidence it
  emits parseable JSON-ish flags. Until task 10 scores a candidate,
  `metrics.llm` quality should be treated as unproven; the all-null
  fallback is correct behavior, not a fix for this.
- **The trivial-skip gate (task 9) will not silently degrade metrics.**
  Skipped messages have no LLM flags at all — analytical queries must
  distinguish "skipped" from "classified nulls". Mitigation: the gate
  fires only on a narrow curated allowlist plus length/stopword bounds;
  fail-closed otherwise. If this proves undiscernible later, the gate is
  one call site condition to revert.

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
- **"DEEPINFRA_API_KEY is obtainable" — VERIFIED this pass, not assumed.**
  SSH to 142.93.42.191 succeeded and `/opt/tova/.env` on that host contains
  a `DEEPINFRA_API_KEY` entry. Previous plan revisions described the key as
  effectively unreachable ("not in local `.env`"); that doubt is now
  retired by direct verification, so task 10 has no blocked dependency.
- **DeepInfra's API is not the Groq SDK.** DeepInfra exposes an
  OpenAI-compatible `/v1/chat/completions` endpoint; the throwaway eval
  script must call it over plain HTTP (or an OpenAI-style client) rather
  than reusing the `groq-sdk` client — the production DeepInfra connector
  for `inferenceService` is #4's decision, untouched here. Low risk since
  the eval script is throwaway.
- **`max_tokens: 100` may truncate the classification JSON** on
  long-winded models, masquerading as low "quality". Task 10 step 3
  measures truncation explicitly so a candidate isn't wrongly rejected by
  the parse-failure rate alone.
- **Failure visibility ("audit as much as possible in the DB") is already
  shipped as part of the answer to alex-moon's accuracy question —**
  `'parse'` / `'error'` / `'trivial'` land in `metrics.llmSkipReason` on
  every user message, so a misbehaving production model becomes a
  countable query (`countDocuments({ 'metrics.llmSkipReason': 'parse' })`
  or `'error'`) without any extra code. That is the "accuracy" proxy the
  user settled for in this ticket.

## Task checklist

Each item is a small, self-contained commit.

- [x] 1. **Model field**: add optional `metrics` subdocument to
      `Message.ts`. Deterministic part: `wordCount`, `charCount`,
      `lengthBucket` short|medium|long, `avgWordLength`,
      `syllableEstimateAvg`, `codeIndicators` `{ fences, backticks,
 codeTokenCount }`, `stopwordRatio`, `sessionMessageIndex`,
      `hasQuestionMark`, `hasImperative`.
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
- [x] 4. **Wire deterministic metrics into persistence** in `chat.ts`:
      compute `computeDeterministic(content)` and build the indices with
      two `countDocuments({ sessionId, role })`-style queries (added
      _before_ the first `.save()` so they count priors only), attach to
      both user and assistant messages in both streaming and
      non-streaming paths. Keep the two count queries parallel
      (`Promise.all`) to avoid serializing them. Update
      `chat.test.ts` / `chat.stream.test.ts` expectations.
- [x] 5. **LLM classification service** `classifyPromptDimensions(content)`
      in `src/server/services/metricsService.ts`: single call to the
      guard/small model via a prompt that returns five binary/simple
      flags, parsed defensively (extract first JSON-looking object;
      tolerate fences; unknown value = null per flag); on any throw
      return all-nulls (mirroring `titleService` error handling); returns
      the update object **and the promise** so tests can await.
- [x] 6. **Wire classification post-save, fire-and-forget**: after each
      user-message save (both endpoints), call the service and persist via
      `findByIdAndUpdate` with `$set` on `metrics.llm`; `.catch` logs;
      never awaited, never throws into the request path. Assistant
      messages are _not_ classified (see Open questions).
- [x] 7. **Integration tests** in `chat.test.ts` / `chat.stream.test.ts`
      with the existing mocked Groq client: a) every new user and
      assistant turn gets deterministic metrics filled with a
      session-correct index; b) LLM update lands on success (await the
      captured classify promise, then re-fetch the message); c) LLM
      failure leaves `metrics.llm` nulls and the chat response
      unaffected; d) indices increase across 12 turns in one session
      (asserts the >10-message history cap is not leaked into indices).
- [x] 8. **Document**: short section in `docs/overview.md` + a
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

## Decisions since the first pass (verified from the issue thread)

- **Assistant messages: user-only classification, confirmed by alex-moon**
  (issue comment, 2026-09-11). Assistant turns will get _feedback_ which
  rates them against the user messages (#18) — so no LLM classification for
  assistant messages, ever, per this ticket. The shipped behavior is already
  correct.
- **Skip-classification for trivially neutral prompts: confirmed as a
  task.** alex-moon wants deterministic detection of "meaningfully neutral
  on all classifiers" prompts ("yes", "please continue", "tell me more")
  to skip the LLM call entirely. He notes regexes were used for this in
  the past but wants something more robust. See task 9.
- **Classification model: `allam-2-7b` is not trusted to emit structured
  JSON reliably.** alex-moon wants the smallest/fastest model that is
  _reliable_, and has confirmed an experimentation path: DeepInfra offers
  a much larger model catalog than Groq, and a `DEEPINFRA_API_KEY` is
  available on the deploy host (142.93.42.191 — note: **not** in the local
  `/opt/tova/.env`, which only has `GROQ_API_KEY`). See task 10.
- **Session-index semantics: alex-moon deferred** ("I don't understand the
  code well enough to answer"); the agent posted the requested
  filepaths/line numbers on #17 and the PR-review "pick one" comment was
  resolved by persisting only `sessionMessageIndex` (all roles, count of
  priors at write time). This ticket now has nothing left to decide: the
  router/feedback work must read `sessionMessageIndex`
  (`src/server/models/Message.ts:33`) or its own counter.

## Task checklist (new work on this branch)

Each item is a small, self-contained commit.

- [x] 9. **Trivial-prompt skip gate** in `metricsService.ts`: a
      deterministic `isTriviallyNeutral(content)` predicate that skips
      the LLM classification call for prompts meaningfully neutral on
      every LLM dimension (short greetings, confirmations, "please
      continue"-style continuations). Robustness requirement from
      alex-moon: not just a regex — combine (a) a small curated phrase
      list (lower-cased, punctuation-stripped match), (b) word-count and
      stopword-ratio bounds from the already-computed deterministic
      metrics, (c) fail-closed (classify) when the heuristic is unsure.
      Unit tests assert both directions: skipping "yes", "ok thanks",
      "tell me more"; NOT skipping "please continue writing the debate
      section". Wire the gate in `chat.ts:85` and `chat.ts:166` (both
      `classifyAndPersistPromptDimensions` call sites) so the skip is a
      `return` before the model call. **Done (2026-09-11):** implemented as
      `isTriviallyNeutral` in `metricsService.ts` — curated phrase list
      (lower-cased, punctuation-stripped) plus a generic ≤3-word
      all-neutral-tokens rule (covers "yeah sure" beyond the list), both
      bounded by deterministic metrics: word count ≤ 6 (≤ 3 for the token
      rule), no question mark, no code indicators, fail closed otherwise.
      Wired as an `if (!isTriviallyNeutral(content))` guard at both
      fire-and-forget call sites in `chat.ts`; skipped messages keep
      `metrics.llm` all-null and are analytically distinguishable from
      classified nulls (they never hit the Groq client). 5 unit tests added
      in `metricsService.test.ts` (both directions per alex-moon's
      examples); suite at 75 passing; lint, typecheck, full Jest green.
- [x] 10. **Validate and switch the classification model** (revised
      2026-09-11 into concrete steps; executed 2026-09-11 — see 10a–10d
      below). alex-moon's final
      bar for this is deliberately modest: _"just pick a model and log
      failures in the metrics object in the DB so we get an idea of how
      many times it fails — we don't need to eval 'accuracy' at this early
      stage."_ No accuracy harness, no per-flag bias analysis:
      `metrics.llmSkipReason` ('parse'/'error' vs null) is already the
      failure log.
- [x] 10a. **Fetch the key.** Get `DEEPINFRA_API_KEY` from
      `/opt/tova/.env` on 142.93.42.191 via SSH and write it to the
      local **untracked** `.env` (gitignored; never commit it). Done:
      key fetched and appended to the local `.env` on 2026-09-11.
- [x] 10b. **Eval script.** Write a throwaway
      `scripts/eval-classify-models.ts` running a fixed list of ~20
      representative prompts through each candidate small model from the
      DeepInfra catalog (DeepInfra serves an OpenAI-compatible chat API —
      the eval script calls it directly over HTTP; only the throwaway
      script does this, so no production-client decision is needed here;
      the DeepInfra connector itself is ticket #4's scoped work against
      `inferenceService.ts`). Done: script in place, calls DeepInfra's
      `/v1/openai/chat/completions` directly with the production
      `LLM_PROMPT`, `temperature: 0` and `max_tokens: 100`, and scores
      outputs with the production `parseLlmFlags`.
- [x] 10c. **Score candidates.** Run on 2026-09-11, 20 prompts per
      candidate, production parser, `max_tokens: 100`:

      | model | parsed | fully parsed | truncations | mean latency |

|---|---|---|---|---|
| google/gemma-3-4b-it | 20/20 | 20/20 | 0 | 1267 ms |
| meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo | 20/20 | 20/20 | 0 | 2196 ms |
| Qwen/Qwen3.5-9B | 0/20 | 0/20 | 20 (100%) | 2387 ms |
| google/gemma-3-12b-it | 20/20 | 20/20 | 0 | 1734 ms |
| mistralai/Mistral-Nemo-Instruct-2407 | 20/20 | 20/20 | 0 | 1603 ms |

      Scores also posted as a comment on #17 (per alex-moon's request).

- [x] 10d. **Switch if justified.** **Pick: `google/gemma-3-4b-it`** —
      the smallest and fastest candidate with a perfect parse rate
      (20/20 ≥1-flag parses, 20/20 fully parsed, zero truncation,
      lowest mean latency). Per the modest bar, flag _correctness_ was
      not evalled; failures will show up as `metrics.llmSkipReason` in
      the DB. **The default in `metricsService.ts:5` is intentionally
      NOT switched yet:** production classification goes through the
      Groq SDK, which cannot serve DeepInfra/Gemma models — flipping
      `LLM_MODEL` now would make every classification call fail
      (`llmSkipReason: 'error'` for all messages) until the DeepInfra
      connector lands. The switch rides on #4 wiring DeepInfra into
      `inferenceService.ts`; `metricsService.ts:5` is a one-line change
      at that point. Scores recorded here; never ship a switch without
      scores. Rerun `npm run ci` (10e).

## Decisions since the second pass (all answered by alex-moon on #17 / PR #22)

- **`metrics.llmSkipReason` — yes, record why flags are null** ("Yes
  please! Audit as much as possible in the DB."), and it is implemented in
  the working tree: `'trivial'` (skip gate, set at save time in `chat.ts`),
  `'parse'` (call succeeded, output unusable) or `'error'` (inference call
  failed) in `metricsService.ts`, cleared to null on a successful
  classification. Schema at `src/server/models/Message.ts:47`; tested for
  all three paths; 79 tests pass; `npm run ci` green (verified this pass).
- **DeepInfra enters the codebase as a connector** ("alongside a
  GroqConnector, delegated to by an InferenceService"), and the service is
  written **in this ticket** — but the DeepInfra connector itself is #4's
  work. Shipped: `src/server/services/inferenceService.ts` with a single
  `groq` connector; all four completion call sites (`chat.ts`,
  `routerService.ts`, `titleService.ts`, `metricsService.ts`) now route
  through it.
- **No accuracy eval needed at this stage** ("just pick a model and log
  failures in the metrics object... we don't need to eval 'accuracy'").
  Task 10's bar is parse rate + speed only; failure visibility in the DB
  is the accuracy proxy.
- **Assistant messages never classified in this ticket** (`#18` rates
  them via feedback against user messages instead). Shipped as such.

## Open questions

No planned task depends on an open question. After this revision pass,
every previously listed open item is either answered in the issue thread
(moved into the plan above) or closed as moot. The question _below_ is
the one with remaining genuine doubt; it ships with a default.

- **Backfill of existing messages**: out of scope — the issue only
  requires forward-going fills for new turns, and alex-moon has never
  asked for backfill. Recorded here as a decision (in "Decisions"),
  flagged once so a later "why are old messages null" question doesn't
  read as a bug.
- **Decoy-with-nested-flags edge in `parseLlmFlags` (found in the third
  critic pass, not fixed here)**: when the parser meets a decoy object
  that is all-null _at top level_ (e.g. `{"meta": {"emotional": true}}`),
  it restarts scanning at the next `{` — which can be the decoy's own
  nested object — so a decoy carrying nested valid flag values ahead of
  the real flags can yield the decoy's value instead of the final one
  (contrived output like `Note: {"meta": {"emotional": true}} Final:
{"emotional": false}`). Hardening this means tracking brace depth across
  the restart, which complicates a parser that today handles the realistic
  failure modes (fenced output, prose wrapping, flag-keyed decoys) and
  over-classifying-decoy risk is a model-quality problem that task 10's
  parse-rate logging is designed to surface. Default: leave as is; revisit
  only if task 10 shows the chosen model actually emits this shape.

## Implementation notes (from the critique pass)

- `metricsService.parseLlmFlags` extends from the first `{` to successive
  `}` until a chunk parses, so fenced output, prose-wrapped JSON, and
  trailing text after the JSON all parse; per-flag unknown values degrade
  to `null` independently; a throw (or response without `choices`) returns
  all nulls.
- `chat.ts` appends deterministic metrics plus `sessionMessageIndex` in
  `buildMessageMetrics` (a single `countDocuments` count of _priors_ only).
- The fire-and-forget classification made the existing stream test mocks
  fragile (the classify call consumed queued `mockResolvedValueOnce` stream
  mocks), so `chat.stream.test.ts` mocks are now arg-aware (`stream`, or
  the classifier prompt) instead of queue-based.
- Second critic pass (2026-09-11): `parseLlmFlags` no longer accepts the
  first JSON object that merely _parses_ — a decoy object (e.g. a format
  example echoed by the model) with none of the five expected keys is
  skipped and scanning restarts at the next `{`, so decoy-before-real-flags
  output no longer degrades to all nulls (unit tests added). Also fixed a
  test flake source: `chat.stream.test.ts` fetched its messages _before_
  `flush()` and asserted LLM flags on the stale pre-classification snapshot;
  it now re-fetches after the flush. `npm run ci` green; suite at 77 tests.
- Third critic pass (2026-09-11): hardening landed —
  (a) `parseLlmFlags` now tolerates casing/whitespace in `sentiment`
  (`"Negative "`, `"POSITIVE"` parse; unknown values still null) with a unit
  test, plus a trailing-decoy-after-real-flags unit test;
  (b) `chat.ts` computed `isTriviallyNeutral(content)` twice per user
  message in each endpoint; the user-turn save (metrics + skip audit +
  fire-and-forget call) is now one helper, `saveUserMessageWithMetrics`,
  shared by both endpoints, so the gate is evaluated once;
  (c) a coverage gap closed: the streaming endpoint's trivial-skip call
  site had no integration test — added one asserting no classifier call
  fires, `llmSkipReason: 'trivial'` is recorded, and deterministic metrics
  still attach. Suite at 82 tests; `npm run ci` green (verified this pass).
  One unfixed parser edge (decoy with nested valid flags) is documented in
  _Open questions_.
