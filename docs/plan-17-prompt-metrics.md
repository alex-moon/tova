# Plan — fix/tv/17-prompt-metrics (per-message prompt metrics)

GitHub issue: https://github.com/alex-moon/tova/issues/17

## Motivation

We want to understand **why** the router picks the model it picks, and later,
**whether that choice was right** (the upcoming feedback ticket will consume
these). Today, the router (`src/server/services/routerService.ts`) decides with
deterministic rules plus a guard-model pass, but nothing is recorded about the
*prompt itself*. The router only persists the outcome (`modelName`) on the
assistant message; the message documents carry no features.

This ticket collects a set of per-message metrics and persists them alongside
each message document in MongoDB, so future analysis (and eventually feedback)
can correlate routing decisions with prompt characteristics.

## Current state (verified from the repo)

- `src/server/models/Message.ts` — schema has `sessionId`, `role`, `content`,
  `modelName`, `timestamp`. No `metrics` field.
- Messages are created inline in `src/server/routes/chat.ts`:
  non-streaming at :56 (user) / :86 (assistant); streaming at :130 (user) /
  :193 (assistant). Messages are create-only today — never updated after save.
- LLM single-prompt patterns to mimic exist in `routerService.ts:49–72`
  (guard classifier, env-configurable `allam-2-7b`) and
  `titleService.ts:13` (`generateChatTitle`, try/catch fallback).
- No structured-output (JSON mode) calls exist anywhere; the router parses
  free text. No cache layers exist. No prompt-metrics code exists at all.
- Streaming flow: user message saved (:135) → `routeQuery` (:138) → SSE
  stream accumulated (:171–183) → assistant message saved (:193). Both
  endpoints `await` message saves. Insertion point for fire-and-forget work:
  right after each `save()`.
- Tests: Jest + ts-jest with `MongoMemoryServer` setup
  (`src/server/test/setup.ts`); closest existing pattern is
  `src/server/services/routerService.test.ts`.

## Decisions so far

1. **`metrics` subdocument** on `Message` (schemas-notation: an embedded
   object, not a separate collection) — matches the issue's suggestion and
   keeps a message + its features in one document.
2. **Deterministic metrics** are computed synchronously in a pure TS module
   (no deps, no I/O) and attached *before* the first `.save()` — zero added
   latency and no post-hoc update needed for them.
3. **LLM-classified dimensions** run post-save, fire-and-forget, as a second
   `Message.findByIdAndUpdate(_id, { metrics.llm })` — so *) nothing is added
   to first-token latency; b) a failed classification never breaks the chat
   request (errors are logged, dimensions remain `null`).
4. **One cheap classification call per message** using the guard/small model
   path (env `ROUTER_GUARD_MODEL`), asking for structured flags, parsed
   defensively as JSON with fallback to nulls (no reliance on Groq JSON mode,
   since we have no precedent for it — see Open questions).
5. **"Cached"**: within a request boundary the classification result of each
   user message serves as-is; cross-request LLM caching is deferred (no cache
   infra exists; building one is out of scope for this ticket).
6. Prompt-shaping helpers (stopword list, syllable heuristic) live inline in
   the pure module — no dependency added.

## Task checklist

Each item is a small, self-contained commit.

- [ ] 1. **Model field**: add optional `metrics` subdocument to
       `Message.ts` — deterministic part (`wordCount`, `charCount`,
       `lengthBucket` short|medium|long, `avgWordLength`,
       `syllableEstimateAvg`, `codeIndicators` { fences, backticks, tokens },
       `stopwordRatio`, `sessionMessageIndex`, `hasQuestionMark`,
       `hasImperative`) and nullable LLM part (`emotional`, `technical`,
       `abstract`, `sentiment`, `openEnded`) — all LLM fields nullable.
- [ ] 2. **Deterministic metrics module**: `src/server/services/promptMetrics.ts`
       — pure functions, no deps, computing everything in checklist item 1's
       deterministic section except `sessionMessageIndex` (needs context).
       Include the vowel-cluster syllable heuristic and a lightweight
       imperative-verb check (message starts with a known imperative verb).
- [ ] 3. **Unit tests** for the module above,
       `promptMetrics.test.ts`, following `routerService.test.ts` style:
       counts, buckets, code detection, stopword ratio, question/imperative
       detection, edge cases (empty string, unicode, long code blocks).
- [ ] 4. **Wire deterministic metrics into persistence**: attach metrics to
       the user message (and assistant message content) in both streaming and
       non-streaming paths in `chat.ts`, including `sessionMessageIndex`
       (index of the message within the session, computable from the history
       length we already fetch). Update `chat.test.ts` /
       `chat.stream.test.ts` expectations.
- [ ] 5. **LLM classification service**: `classifyPromptDimensions(content)`
       in a new `metricsService.ts` — single call to the guard/small model
       with a prompt that returns five binary flags, parsed defensively
       (JSON-ish extraction), returning nulls per dimension on any failure
       (mirroring `titleService` error handling).
- [ ] 6. **Wire classification post-save, fire-and-forget**: after each
       user-message save (both endpoints), kick off the classification and
       update the message's `metrics.llm` on completion; `.catch(console.error)`,
       never awaited, never throws into the request path.
- [ ] 7. **Integration tests**: with mocked Groq client, assert a) every new
       user turn ends with deterministic metrics filled, b) LLM update lands
       on success, c) LLM failure leaves `metrics.llm` nulls and the chat
       response unaffected.
- [ ] 8. **Document**: add a short section to `docs/overview.md` (or a note
       in `docs/progress.md` on merge) describing the collected metrics and
       how to inspect them (e.g. via `scripts/mongo.ts` snippet).

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`
- `npm --prefix src/client run lint` only if client code changes (not planned)
- `npm run ci` as the final gate.

## Acceptance criteria (from the issue)

- Every new user/assistant turn gets its `metrics` subdocument filled.
- Deterministic metrics are covered by unit tests.
- No visible latency added to first token (classification is post-save,
  fire-and-forget).

## Open questions

- **Does the Groq SDK / our guard model support reliable JSON output?** We
  have no existing structured-output precedent in this repo. Plan 5 assumes a
  plain completion parsed defensively; if the small model proves unreliable
  at emitting parseable flags, the fallback is nulls (already handled) and we
  may revisit with `response_format` inside this same ticket's scope.
- **Assistant messages too?** The issue says "every assistant/user turn gets
  metrics filled". Assistant content metric computation is cheap and included
  (task 4), but it is unclear whether the *LLM classification* should run for
  assistant messages as well (cost: one extra call per assistant turn). I
  propose classifying user messages only, unless reviewers object.
- **Guard vs small model for classification**: 5 flags in one call may be
  tight for `allam-2-7b` ('ROUTER_GUARD_MODEL'). Untested; if quality is poor,
  switching to `ROUTER_SMALL_MODEL` is a one-line env change rather than a
  redesign.
- **`sessionMessageIndex` semantics**: whether it should count only user
  messages or all messages in the session. Assuming *all messages* (total
  docs in the session at write time) unless the router work later proves
  user-only is more useful.
- **Existing messages**: the issue only requires goto-forward fills for new
  turns; a backfill script for old messages is intentionally out of scope.
