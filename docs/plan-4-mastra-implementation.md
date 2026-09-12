# Plan — feat/tv/4-mastra-implementation (Mastra + DeepInfra, DB-based routing)

GitHub issue: https://github.com/alex-moon/tova/issues/4

## Motivation

The current issue body (authoritative) asks for two things:

1. **DeepInfra integration + DB-based provider/model routing.** Today every
   turn goes through `routerService.routeQuery` → one Groq model
   (small/large/guard via `ROUTER_*` envs). We want multiple providers and a
   model pool stored in MongoDB, with routing based on the existing
   small/large classifier plus some randomness, so real feedback data starts
   accumulating.
2. **Mastra.** Re-implement the LLM-touching paths on
   [Mastra](https://mastra.ai) where it earns its place, centralising all
   Mastra imports in a single service, with Groq and DeepInfra relegated to
   thin provider classes behind it.

The issue's only comment quotes the earlier, broader description (catalog,
query enhancement, decomposition, tool loops). That text moves nothing into
scope here, and answers none of the questions below — it is history, not a
spec for this ticket. Those broader suggestions are delegated/follow-ups.

## Current state (verified from the repo, as of revision)

- `src/server/services/inferenceService.ts` — hand-rolled `LlmConnector`
  interface wrapping `groq-sdk`, one hard-wired `groqConnector`, a comment
  pointing at #4. Its types are Groq types
  (`Groq.Chat.ChatCompletion` / `ChatCompletionChunk`).
- **Every consumer of `inferenceService` (verified by grep):**
  - `routerService.ts:44` — guard classifier call (small completion,
    `max_tokens: 10`). Note `ROUTER_GUARD_MODEL` default is `allam-2-7b`,
    with no provider prefix and no guarantee it is even a Groq-hosted model.
  - `titleService.ts:13` — title generation (blocking).
  - `metricsService.ts:99` — prompt-metrics classification.
  - `routes/chat.ts:111` (blocking turn) and `routes/chat.ts:200`
    (SSE streaming turn). The streaming consumer iterates chunks of the
    Groq `ChatCompletionChunk` shape directly.
- `routes/chat.ts` also calls `routeQuery` per turn and persists the chosen
  model name on the assistant message (must keep working).
- No `mastra` package in the lockfile, no `@mastra/*` in `node_modules`.
- No DeepInfra client code; no MongoDB-backed model/provider config today.
- Existing structure: config lives in a `providerRouting`-like shape only in
  this plan; collections are created lazily by services elsewhere.

## Principles / decisions

- **Mastra behind one service:** routes, auth, MongoDB models, SSE contract
  stay as-is; only LLM-call paths move behind a single service module
  (evolving `inferenceService`). Provider classes must not import `@mastra/*`
  directly.
- **Providers get thin:** Groq and DeepInfra classes reduce to adapter
  surface (base URL, API key, model identity) once Mastra owns
  completion/streaming mechanics.
- **Routing config in MongoDB:** a small `providerRouting` collection seeded
  with Groq + DeepInfra entries; envs remain as fallback.
- **ε-random tier routing:** when several models qualify for a classified
  tier, pick ε-randomly so per-model feedback accrues. ε via env with a
  default; semantics (within-tier vs cross-tier) currently uncertain — see
  Open questions. Task 5 must not be implemented until that is resolved.
- **Contract stability:** `/api/chat/stream` SSE event set unchanged;
  `Message.modelName` records the model that actually ran.

## Verified facts about the current code (second pass, fuller grep)

Beyond the caller list above, these facts now anchor the detailed steps:

- `inferenceService`'s interface is literally Groq-typed:
  `createCompletion` returns `Promise<Groq.Chat.ChatCompletion>` and
  `createStreamingCompletion` returns
  `AsyncIterable<Groq.Chat.ChatCompletionChunk>` (inferenceService.ts:16–21).
  Every downstream consumer — including the return values only read by
  `titleService` / `metricsService` — inherits that Groq typing today.
- The streaming consumer only uses one field:
  `chunk.choices[0]?.delta?.content` (routes/chat.ts:206). So the _minimum_
  neutral streaming surface is `AsyncIterable<{ delta?: string | null }>`.
  Anything more (usage chunks, finish reasons, tool calls) is unused.
- The blocking consumer only uses `choices[0]?.message?.content`
  (routes/chat.ts:116). Same narrowing applies.
- SSE events emitted today: `meta`, `delta`, `error`, `done` — each written
  with the same `event:`/`data:` envelope, no new event kinds needed by this
  ticket. `meta` carries `{ sessionId, routing: { model, reason } }`;
  `done` carries the full persisted `assistantMessage` and a `complete`
  boolean that flips to `false` on mid-stream errors.
- Tests mock at the _module_ level: `chat.stream.test.ts` replaces `groq-sdk`
  itself with a stub whose `chat.completions.create` returns
  `mockCreate(...args)`, and separately stubs `routeQuery`. So any change
  inside `inferenceService` (where `groq-sdk` is actually imported) is
  invisible to those tests as long as `default export` of the module keeps
  the constructor shape — i.e. the current mock strategy breaks if the
  `groq-sdk` import moves to the provider layer and is the only
  transport-mock point. Plan for this explicitly (task 9).
- `modelConfigService.listByTier` (shipped, task 2) already returns
  `ModelRef[]` = `{ provider, model }`; `RouterConfig` still takes bare
  model _strings_ and `routerService` still hard-maps the guard/small/large
  outcome onto `DEFAULT_CONFIG` env strings.
- **Provider identity vs model string** (new this pass, resolved without
  user input): env-default model strings legitimately contain
  slashes (`openai/gpt-oss-20b` is Groq's own public id for that model;
  `Qwen/Qwen2.5-72B-Instruct` is DeepInfra's form). Risk was a provider
  being parsed out of the model string; resolved — provider always rides
  the separate DB/config field, and Mastra's `parseModelString` handles
  nested-slash router ids by design (source cited in task 6a).

## Checklist

Concrete, individually commit-safe steps:

1. ~~**Feasibility spike** — superseded by task 4 below (done).~~
2. **`providerRouting` collection + `modelConfigService`** — _shipped
   (see the critic-pass revision note below). Remaining detail from the
   original stub: DeepInfra large-tier seed identity
   (`Qwen/Qwen2.5-72B-Instruct`) is provisional and editable in the DB;
   its fitness for a "large" tier has not actually been evaluated. Also
   note the guard tier currently has only a Groq seed entry — whether a
   DeepInfra guard model should exist is part of D._
3. **Define neutral result/chunk types (prerequisite, no Mastra import
   yet).** — _shipped (see critic note below)._
4. ~~**Feasibility spike: pin Mastra packages (research, no app code).** —
   _shipped; results recorded in "Resolved questions (from the task-4
   spike)" below and posted to issue #4. Tasks 5–6 are unblocked._~~

5. **Centralised Mastra service + two provider classes.** — _shipped (see
   the task-5 note below)._
6. **Reroute the blocking paths through provider-aware config**, split so
   it does _not_ depend on task 7 (which is gated on D):
   - **6a — provider plumbing, no DB dependency:** _shipped (see the
     task-6a/6c note below)._
   - **6b — real-provider smoke (H-residual):** _done live with keys (they
     were in `.env` all along). Found and fixed two real shipped bugs —
     the flat-`delta` mapper bug and the silent error-chunk swallow.
     Retry-duplication handling deliberately not added per the user's H
     answer. See the finishing-pass note._
   - **6c — cheap hardening from the fourth critic pass:** wire
     `req.on('close')` → `abortSignal` through `CompletionOptions`
     (task 6 already touches both streaming call sites; behaviour gap is
     pre-existing, not a regression). — _shipped (see the task-6a/6c
     note below)._
   - `titleService` / `metricsService` / guard-classifier callers stay
     untagged — they get `groq` implicitly. Their migration is task 8.
7. **ε-random tier routing in `routerService`.** _shipped (see the
   finishing-pass note; was hard-gated on D, which is now resolved)._
   - `RouterConfig` per tier becomes `ModelRef[]` from
     `modelConfigService.listByTier` (env single-model is the degenerate
     fallback `listByTier` already returns).
   - ≥2 entries in a tier → pick ε-randomly; 1 → deterministic as today.
     ε via `ROUTER_EPSILON` env with a fixed default; seeded once at
     startup, injected PRNG in tests.
   - Guard tier pool membership and ε semantics are exactly what D pins;
     the task also inherits F/G (stale seeds, ineligible fallback) once
     answered — `listByTier` behaviour is already shipped and its current
     fallback semantics are pinned by tests, so any semantic change lands
     here as a deliberate diff, not silently.
8. **Migrate remaining callers (`titleService`, `metricsService`, guard
   call inside `routerService`) to the central service; delete dead
   connector code.** _done — all callers already route via
   `inferenceService`/`mastraService`; `groq-sdk` gone; nothing dead left
   (see the finishing-pass note)._
   - Guard classifier call stays functionally identical (same prompt,
     temperature 0, `max_tokens: 10`) — call-site/provider swap only, not
     into the DB-pool ε-selection (that is D-territory).
   - Scope of "reimplement in Mastra" is E: conservative reading
     (orchestration-only, no Mastra agents/workflows inside
     `titleService`/`metricsService`) is what this task implements unless
     the user pins broader.
   - Delete any dead connector code left behind by task 5 once no caller
     hits it.
9. **Tests.** _done — see the finishing-pass note and the sixth critic
   pass (route-level DeepInfra). Existing suites keep passing._ Add:
   - router-id construction with a slash-containing model id (6a pin, see
     above);
   - DB-config selection feeding `routeQuery` end-to-end;
   - ε-random determinism with an injected PRNG + the ε=0 / ε=1 edges
     (part of task 7);
   - DeepInfra path exercised in a mocked unit test at the route level,
     not just the connector unit tests;
   - a test that `Message.modelName` records the **chosen** model when
     the pool for a tier is non-trivial.
10. **`npm run ci`, fix fallout, update `docs/progress.md`.** _done — `npm
run ci` fully green (131 server tests incl. stream/sse suites + client
    suites/build); see the finishing-pass note._ Explicitly:
    check `npm test` output shows the stream/sse suites actually ran
    (jest's per-worker transform failures can shed coverage silently) —
    the I resolution (jest stub + `jest.mock` per suite) means any suite
    that still imports the real `@mastra/core` in a worker fails with a
    clear stub-construction error, but confirm nothing silently skipped.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run ci` at the end,
  per repo convention.
- All provider calls mocked in tests; no provider API keys assumed in CI.
- Manual smoke (local only, if keys present in the user's env): one non-code
  query and one code query, confirming different `reason`s still surface and
  SSE stream shape is unchanged.

## Follow-ups (out of scope for this ticket)

- Consuming the ε-random multi-model data in per-message feedback — likely
  its own ticket once data flows.
- Retiring `ROUTER_SMALL/LARGE/GUARD_MODEL` envs once DB config is proven,
  with a migration note for existing deployments.
- The earlier (superseded) issue text's suggestions — model catalog
  selectable per chat, query enhancement/decomposition, agentic tool loops —
  tracked separately, not here.

## Open questions — ALL RESOLVED (by the user, 2026-09-12)

All items are now answered; the detailed steps above carry them as facts.
(Historically: A, B, C and the env-naming half of H were resolved
empirically by the task-4 spike; the jest-transform half of I definitively
in task 5 — the worker cannot load `@mastra/core`'s CJS build because the
transitive `@sindresorhus/slugify` is ESM-only, so the `moduleNameMapper`
stub is shipped at `jest.config.js:12`.) The remaining items D/E/F/G/H/J
were answered by the user on 2026-09-12 and are recorded below:

- **D. ε-randomness semantics — RESOLVED:** ε (the knob) is free to any
  value; starting behaviour: when exactly one model is eligible for a tier,
  always use it; otherwise pick uniformly at random (even distribution).
  Implemented as standard ε-greedy with an independent explore/index draw
  (`ROUTER_EPSILON` default 1); no model available at all — fails loudly. The guard classifier call stays a single env/model (`allam-2-7b`,
  verified live against the real Groq endpoint) — it is tier-0 tooling, not
  a chat turn.
- **E. Scope of "reimplement in Mastra" — RESOLVED:** all LLM-facing work
  goes through Mastra via the centralised service (conservative reading:
  no per-service Mastra agents/workflows yet; everything will be tied into
  a workflow later).
- **F. Stale env-seeded rows — RESOLVED (user clarified it was not about
  keys): seed only when a tier has no entries; after that the DB is
  authoritative. Stale rows are editable in the DB; env changes never
  silently overwrite or fall back.
- **G. Eligible-tier fallback semantics — RESOLVED:** if no model is
  available, fail noisily (throw). The unknown-provider dispatch guard
  already had this shape.
- **H-residual — RESOLVED:** no special Mastra retry handling for now.
  Live smoke found that Mastra wraps stream starts in `p-retry` and that
  upstream errors surface as stream chunks rather than throws — see the
  task-6b note below; retry-duplication will be observed, not pre-empted.
- **J. Empty-response handling — RESOLVED:** persist the empty value (`''`)
  in the DB; present `'(no content returned)'` in the UI only. No silent
  failure: the turn stays visible.

No unresolved open question remains on this ticket.

No unresolved open question has a live task depending on it: task 6 is
explicitly structured (6a/6b/6c) so it needs none of D/E/F/G, and tasks 9–10
only test/pin whatever tasks 2–8 shipped.

### Task-5 implementation note (shipped on this branch)

What landed:

- `@mastra/core@1.66.0` added to `dependencies` (dual ESM/CJS build confirmed;
  runtime loads under tsx/Node 22 — `boot-ok` check passed).
- `src/server/services/mastraService.ts` — the single owner of all
  `@mastra/*` imports and provider construction. Exports `groqConnector` /
  `deepinfraConnector` (`LlmConnector`); both aim a per-call `Agent` at the
  bundled-router id `groq/<model>` / `deepinfra/<model>` and normalise
  `agent.generate` (`{ text }`) / `agent.stream().fullStream`
  (`text-delta → { delta }`, lifecycle chunks filtered) to the neutral
  types. `maxSteps` hard-capped at 1 so a plain completion cannot loop;
  `max_tokens` maps to `maxOutputTokens` inside `modelSettings`.
- `inferenceService` now dispatches on `options.provider`
  (`CompletionOptions.provider?: 'groq' | 'deepinfra'`, default `groq`);
  the `groq-sdk` module-level import is gone entirely. Un-tagged callers
  (guard classifier, title, metrics) still land on Groq, so only routing
  work (task 6/8) can flip them.
- Test mocks retargeted in the same change: all `groq-sdk` module mocks
  (route + service tests) now mock `@mastra/core/agent`, keeping the real
  Mastra→neutral mapping under test end-to-end; new `mastraService.test.ts`
  pins the mapping (text-delta/lifecycle filtering, defensive missing-delta,
  router-id construction for both providers, error propagation);
  `inferenceService.test.ts` pins provider dispatch (incl. the default).
- `npm run ci` fully green after this task (131 checks incl. client build).

Open-question resolutions from this task:

- **I-residual resolved — jest transform:** `@mastra/core`'s CJS build does
  NOT load inside a jest worker: its transitive dep `@sindresorhus/slugify`
  is ESM-only and ts-jest in CJS mode cannot `require` it. Decision taken
  deliberately per plan: jest config maps
  `'@mastra/core/agent' → src/server/test/mastraAgentStub.ts`
  (a stressy stub whose `Agent` throws if ever constructed), and every suite
  needing agent behaviour replaces the module wholesale via
  `jest.mock('@mastra/core/agent', ...)` — so the real Mastra machinery is
  never loaded in Jest, but the mapping boundary in `mastraService` (the
  part this ticket owns) is fully unit-pinned. Production/runtime under tsx
  loads the real package fine (verified with a boot check).
- **H-residual (real-provider smoke): NOT done** — no provider keys in this
  environment; the empirical retry/duplicate-delta question stays open and
  is carried into task 6's smoke step verbatim. The mock test suite does not
  lean on unverified retry behaviour.
- Guard model note surfaced by the wiring: an un-tagged `ROUTER_GUARD_MODEL`
  default (`allam-2-7b`) now routes as `groq/allam-2-7b` — the Mastra router
  form requires a provider prefix. Whether `allam-2-7b` is a Groq-hosted
  model at all remains part of open question D (tasks before 8 are not
  affected: existing routes/tests keep using mocked routing).

Remaining open questions: D, E, F, G (unchanged; tasks 6, 9, 10 do not
depend on them).

### Critic-pass revision (after first deliverable on this branch)

Only task 2 had shipped at this point (`providerRouting` model +
`modelConfigService`), with two hardening tests and a fixed uncaught-failure
bug: a failing `ProviderRouting.find` (dead Mongo) propagated out of
`listByTier` instead of falling back to the env-configured model. Defaults
table (`DEFAULT_MODEL_ENV`) is the single source of truth shared by seeding
and the env fallback, and concurrent first reads are covered.

Task 3 shipped on top of task 2: `src/server/services/llmTypes.ts` defines
provider-neutral types (`NeutralCompletion`, `NeutralStreamChunk` =
`{ delta?: string | null }`, `NeutralChunkStream`, provider-agnostic
`LlmConnector`). `inferenceService` normalises Groq shapes into the neutral
types (mapping lives inside the service only); the streaming consumer in
`routes/chat.ts` now reads `chunk.delta`. The protected narrowing held:
existing call sites (`titleService`, `metricsService`, `routerService`)
use `choices[0]?.message?.content` and keep working unchanged. One guard
lesson captured: the Groq→neutral mapping must be defensive (missing
`choices`) because the "unexpected response shape" test asserts exactly
that path skips with `skipReason: 'parse'` — a strict mapper silently
changed the failure mode. Tests, lint, typecheck all green.

### Task-4 spike results (research, no app code; verified in `/tmp` on Node v22 with `@mastra/core@1.66.0`)

- **A resolved — provider surface:** No `@mastra/groq`/`@mastra/deepinfra`
  packages exist. Mastra v1 ships both providers _inside the model router_
  bundled in `@mastra/core` (verified: `case "groq": createGroq(...)` and
  `case "deepinfra": createDeepInfra(...)` in `models-dev-*.js`). Model
  ids take the `groq/<model>` / `deepinfra/<model>` router form, or the
  explicit OpenAI-compatible object form
  `{ providerId, modelId, url?, apiKey? }` (verified working against a
  local mock server). No extra provider dependencies needed.
- **B resolved — server-side usage:** `@mastra/core/agent` imports and
  constructs an `Agent` with no dev server, registry, or storage; a bare
  `Mastra` instance only _warns_ about falling back to in-memory storage
  (a warning, not a requirement — our own Mongo persistence is untouched).
  Streaming (`agent.stream` → `fullStream` yields `text-delta` chunks with
  a `.delta` text field) and blocking (`agent.generate` → `.text`) both
  round-tripped cleanly; mapping to `NeutralChunkStream` /
  `NeutralCompletion` is trivial `text-delta → delta`. One observed shim:
  an SSE mock with no finish chunk yields `finishReason: 'other'` and
  retried the whole call (≈5 requests); a faithful mock must return a
  proper `finish_reason` chunk. Real-provider behaviour still to be smoke
  checked locally with keys in task 5.
- **C resolved — streaming:** `agent.stream(...).fullStream` chunks are
  AI-SDK-style (`text-delta` with `.delta`, plus lifecycle chunks
  `start`/`step-start`/`text-start`/`text-end`/`step-finish`/`finish`).
  Mapping to the neutral `{ delta }` surface is a one-line filter inside
  the central service; the SSE contract needs no change.
- **H resolved — env naming:** `DEEPINFRA_API_KEY` is not invented — it is
  the real `environmentVariableName` Mastra's bundled
  `createDeepInfra` uses (and `GROQ_API_KEY` for Groq) when no explicit
  `apiKey` is passed. The plan's name matches the library.
- **I resolved — jest/ESM:** `@mastra/core@1.66.0` ships dual builds
  (`dist/index.js` ESM + `dist/index.cjs` with `require` export paths for
  every subpath); `node -e "require('@mastra/core/agent')"` succeeds, so
  ts-jest in CJS mode should load the central service without transform
  changes. Verify once in a jest worker during task 5 as planned.
- Transitive weight (direct deps of `@mastra/core` 1.66.0): ajv, chat
  (~UI-ish chat package, not a provider), croner, dotenv, execa, fastq,
  p-map/p-retry/lru-cache, ws, posthog-node, tokenx, plus vendored AI-SDK
  provider packages. Import side effects are none observed (constructing
  `Mastra` prints its storage warning; `Agent` alone prints nothing).

Remaining open questions after the spike: D, E, F, G (unchanged, user
input still pending; none of tasks 5–6 depend on them). The spike added
H-residual (retry/duplicate-delta behaviour on real endpoints) and
I-residual (ts-jest worker check) — both since resolved or folded: I by
task 5's shipped stub, H-residual into task 6's smoke step; see the Open
questions section.

### Third critic pass (this branch, after task-4 spike)

State on the branch: tasks 2–4 shipped; task 5 (Mastra service + providers)
not started. `npm run ci` was red only on Prettier formatting of this plan
doc (fixed); all suites green otherwise.

Direct-coverage gap found and closed: the Groq→neutral mappers in
`inferenceService` had no unit tests — only indirect coverage through route
tests that mock `groq-sdk` wholesale. New
`src/server/services/inferenceService.test.ts` pins the mapper boundary.
That immediately caught a **real shipped bug**: the stream mapper read
`chunk.choices[0]` without optional chaining, so a stream chunk with no
`choices` field (malformed or usage-only chunk) threw a TypeError
mid-iterator instead of yielding a neutral `{ delta: null }` — the exact
silent-failure class the neutral layer exists to prevent. Fixed with
`chunk?.choices?.[0]`. The suite also pins: null-content choices, missing
`choices` in a blocking response, empty-string deltas passing through
(consumers already skip falsy deltas), mid-stream transport errors
propagating via the async iterator, and option passthrough (stream flag
owned by the call site, not the options).

Critiqued and accepted as-is (deliberate, documented): env-fallback on any
DB read/seed error in `listByTier` (loud-failure alternative is already
postponed under open question G), empty-string delta semantics in
`routes/chat.ts` (`if (delta)` drops empty deltas — harmless since they
carry no content).

New open questions raised by this pass: F and G (canonical wording kept in
the Open questions section above; not restated here).

### Fourth critic pass (this branch, after task-5 shipping)

State on the branch: tasks 2–5 shipped (commits dc2be16…56444da); tasks 6–10
remain. `npm run ci` fully green before this pass started (114 server
tests + client suite/build).

No new shipped bug found. Two hardening gaps fixed this pass:

- **Unknown-provider dispatch** (`inferenceService.ts`): the connector map
  was indexed directly on `options.provider` (`connectors[provider ??
'groq']`). Because provider refs ultimately come from MongoDB documents
  (validated only as strings at the `listByTier` boundary), a corrupted or
  unsupported provider value produced `undefined` and a bare
  `TypeError: connector is undefined` mid-request, with no indication of
  which config value caused it. The dispatch now throws
  `Unknown LLM provider: <value>` before any connector is touched; pinned
  by new tests in `inferenceService.test.ts` (error message + no-connector
  call). Note the choice here: fail loudly rather than silently fall back
  to Groq, consistent with the loud-failure reading preferred under
  open question G — if G is instead answered "silently fall back", this
  guard should change shape with it.
- **`undefined` keys in `modelSettings`** (`mastraService.ts`): both
  `temperature` and `maxOutputTokens` were forwarded even when unset
  (`{ temperature: undefined, maxOutputTokens: undefined }`), feeding
  `undefined` values into a settings object consumed by the real AI SDK —
  a shape the mocked tests could not falsify. Settings are now built by
  omitting unset fields; pinned by a new test asserting
  `modelSettings: {}` for a bare call and unchanged behaviour when both
  are set.

One behavioural note (not a bug, pre-existing parity kept): the SSE route
(`routes/chat.ts`) has never passed an abort/disconnect signal into the
completion layer. With groq-sdk this dropped silently; with Mastra the
`Agent.stream` call supports `abortSignal`, so a client mid-stream
disconnect still lets the provider call run to completion server-side
(tokens consumed, no deltas delivered). Pre-existing on the old path too,
so no regression — but wiring `req.on('close')` → `abortSignal` through
`CompletionOptions` is a cheap hardening candidate for task 6 (which
already touches the streaming call site). Recorded as a task-6 note, not
an open question: nothing user-decision shaped in it.

Remaining open questions unchanged: D, E, F, G (all already posted to the
issue; tasks 6, 9, 10 do not depend on them). No new user-side questions
were raised by this pass.

### Task-6a/6c implementation note (shipped on this branch, uncommitted)

- **6a:** `RoutingResult` now carries `provider: LlmProvider`, filled with
  the constant `'groq'` on every env-path return (as planned — the DB pool
  cannot reach the router before task 7). `routes/chat.ts` passes
  `provider: routingResult.provider` into `CompletionOptions` at both the
  blocking and streaming call sites; the `meta` SSE event carries the
  routing object unchanged, so it now also includes `provider` (additive
  only). The slash-id pin (task 9's 6a bullet) landed with it: unit test
  asserting `openai/gpt-oss-20b` builds the router id
  `groq/openai/gpt-oss-20b` unsplit; `routerService` metadata-contract test
  asserts `provider === 'groq'`.
- **6c:** `CompletionOptions.abortSignal?` added to the neutral types;
  `mastraService` forwards it into Mastra call options (both `generate` and
  `stream`) via a shared `callOptionsFrom` that omits it when unset;
  `routes/chat.ts` streaming route wires `req.on('close')` → abort, guarded
  by `!res.writableEnded` so a normal end never aborts. Pinned by a
  mastraService unit test (forwarding) and a route test (a real signal on
  the call, not aborted).
- Task 6b (real-provider smoke, H-residual) remains pending on keys; tasks
  7/8 remain gated on D/E. `npm run ci` fully green after this task
  (117 server tests + client suites/build).

### Fifth revision pass (this branch, pre-task-6)

State on the branch: tasks 2–5 shipped (working tree clean, `HEAD`
e963a57); tasks 6–10 not started — re-verified directly from the repo, not
just from issue comments (no `listByTier`/ε in `routerService.ts`, no
`provider` in `routes/chat.ts` call sites). `npm run ci` green as of the
last shipped commit.

What this pass changed and why:

- **Fixed a quiet dependency on an open question:** task 6 as written read
  "once the router returns a `ModelRef`" — but that only happens in task 7,
  which is hard-gated on D. Task 6 is restructured into 6a (provider
  plumbing that needs no DB/ε answer), 6b (H-residual smoke) and 6c
  (abortSignal hardening), and 6a explicitly lands an env-path
  `provider: 'groq'` on `RoutingResult` so the DB-independent work cannot
  be blocked.
- **New verified fact, no open question:** Mastra's `parseModelString`
  splits router ids on the first slash only and is documented to accept
  nested-slash ids; combined with provider identity always riding the
  config field, the slash-containing env-default model ids
  (`openai/gpt-oss-20b`, `Qwen/…`) are safe. Verification source cited in
  task 6a; a unit test pinning it is added to task 6a.
- **Open questions section cleaned:** I-residual removed (resolved by
  task 5's shipped jest stub, not "partially open" as the previous text
  claimed); F/G entries kept as short pointers to the posted wording
  instead of duplicated paraphrases; H-residual folded to task 6b.
- No new user-side open questions of this pass need posting: the only new
  item surfaced (slash-id parsing) was resolvable from shipped dependency
  source and is recorded as a fact above, and D/E/F/G remain unfairly
  answerable only by the user.

### Sixth critic pass (this branch, after 6a/6c; `npm run ci` fully green before the pass, 120 server tests after)

State on the branch: tasks 2–6a/6c shipped; 6b needs real keys; 7/8 gated on D/E. Branch
history verified directly (`git log origin/main..HEAD`; the client-file diffs vs `origin/main`
are main-side changes made after this branch forked — this branch itself touches no client
code, so no drift to fix there).

**Real shipped bug found and fixed — all-empty stream crashed the turn:**
`routes/chat.ts` persisted the streamed assistant message with
`content: assistantContent`, which can be `''` when the provider stream yields no
(or only empty-string) deltas. `Message.content` is required, so the save threw a
ValidationError; because headers were already sent, the catch-all only did `res.end()` —
the SSE client received `meta` and then a silent hang: no `error`, no `done`, nothing
persisted. Fixed by persisting a `'(no content returned)'` place-holder (streaming
route), and the same guard added to the blocking route (whose `|| ''` fallback hit the
identical save-throw path → 500). Pinned by an all-empty-deltas route test (no `delta`
event, `done` with `complete: true`, place-holder persisted). Consequence worth noting:
a stream that produces no content at all still completes cleanly, consistent with the
"keep one assistant message per turn" contract — but the place-holder wording is an
arbitrary UX choice; see Open questions J.

Hardening and tests added this pass:

- **Blocking-route abort wiring** (symmetric with 6c): `POST /api/chat` now creates an
  `AbortController`, aborts on `req 'close'` when `!res.writableEnded`, and passes
  `abortSignal` into `createCompletion` — previously a disconnecting client left the
  blocking provider call running server-side.
- **mastraService streaming abort test** — the abort-forwarding pin existed only on the
  `generate` side; `stream` forwarding now pinned too.
- **Route-level DeepInfra dispatch test** (plan task-9 bullet): a `POST /api/chat` turn
  routed with `provider: 'deepinfra'` dispatches end-to-end — asserted via the mocked
  Agent being constructed with `deepinfra/Qwen/Qwen2.5-72B-Instruct` and
  `Message.modelName` set from the routed model.
- jest config comment typo fixed.

One new open question, posted to issue #4: **J (empty-response place-holder wording)**.

### Finishing pass (2026-09-12, tasks 6b + 7 + 8 + J; `npm run ci` fully green, 131 server tests + client suites/build)

With user answers for D/E/F/G/H/J in hand and API keys confirmed present in
`.env` all along:

- **Task 6b — real-provider smoke (done, live against actual endpoints).**
  Two shipped problems found and fixed:
  1. **`toNeutralStream` read a non-existent field.** Real `fullStream`
     chunks on `@mastra/core@1.66.0` carry text in `payload`:
     `{ type: 'text-delta', payload: { text } }` — the shipped mapper read
     flat `chunk.delta`, so every real stream produced empty deltas all the
     way through the SSE contract. Deltas now map from `payload.text`.
  2. **Upstream errors do not throw in streaming **— they arrive as
     `{ type: 'error', payload: { error } }` chunks (blocking `generate`
     does throw). Per the loud-failure stance (#4 G/H), the mapper rethrows
     error chunks so the route's existing catch emits the SSE `error` event
     instead of silently completing an empty turn.
     Both verified live (Groq + DeepInfra): streaming now delivers real text
     end-to-end; error chunks fail loudly. H-residual observation recorded:
     Mastra wraps stream starts in `p-retry` (visible in stack traces); no
     retry-duplication handling is added for now per the user's H answer.
- **Reasoning-budget discovery:** `openai/gpt-oss-*` models on Groq spend
  hidden reasoning tokens from `max_tokens` before producing text — with
  the 30-token title budget, every call returned `""` (live: at 512 the
  same call returned `"JavaScript function basics"`). `titleService`
  `max_tokens` raised 30 → 512. Guard (`allam-2-7b`) and metrics calls
  verified live and unchanged. Also noted live: `llama-3.1-8b-instant` is
  NOT available to this key (404) — anything seeded off that id would fail
  loudly at dispatch; `allam-2-7b` IS available. `allam-2-7b` is an
  Arabic-first model (metrics output came back with Arabic prose; the JSON
  parser still coped) — candidate for seed replacement later, tracked in
  the DB now.
- **Task 7 — ε-random tier routing (shipped).** `RouterConfig` per tier is
  now `ModelRef[]` pools from `modelConfigService.listByTier`
  (`{ small, large, guardModel }`); `routeQuery(query, config?, random?)`
  picks from the qualifying pool via a new `pickModelRef`: 0 models →
  throw (G, loud); 1 → deterministic; ≥2 → ε-greedy with independent
  explore/index draws so the within-pool choice is uniform (D: even
  distribution), `ROUTER_EPSILON` default 1, injectable PRNG. The picked
  `ModelRef.provider` rides onto `RoutingResult` (not hard-coded). Tests:
  single-model determinism, zero-pool loud failure, ε=0/ε=1 edges,
  multi-model pool with injected PRNG, DeepInfra pick recorded end-to-end,
  DB-config default path (`listByTier` mocked) feeding both tiers.
- **Task 8 — callers/dead code:** verified every remaining call site
  (guard classifier inside `routerService`, `titleService`,
  `metricsService`) already routes through `inferenceService` →
  `mastraService`; `groq-sdk` is gone from `src/` entirely; `@mastra/*` is
  imported only inside `mastraService`. No dead connector code remained to
  delete.
- **J — empty content stored, placeholder presented.** `Message.content`
  changed from `required: true` to a presence validator (`''` now legal);
  both chat routes persist the raw content (`''` for an empty provider
  response); the stream test's placeholder pin updated to `''`. The client
  `ChatWindow` no longer drops empty assistant messages: the in-flight
  optimistic bubble (`stream-`-prefixed id while loading) is still held
  for the thinking dots, but a persisted empty turn renders
  `'(no content returned)'`.
- Remaining pre-task-9 route-level DeepInfra/mocking bullets were already
  in place from the sixth critic pass; nothing further needed. Tasks 2–10
  are complete. Follow-ups worth tickets: retiring `ROUTER_*` envs once DB
  config is proven; per-model feedback data consumption; guard-model seed
  replacement question (`allam-2-7b` Arabic-first tendencies).
