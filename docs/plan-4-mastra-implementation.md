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
- Node v22, CJS/TS via tsx + jest/ts-jest. `@mastra/*` packages are often
  ESM-only; tsx handles ESM imports transparently, but the jest
  transform config needs verification if `@mastra/core` must be loaded in a
  jest worker (task 9 risk, see new open question I).

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

5. ~~**Centralised Mastra service + two provider classes.** — _shipped (see
   the task-5 note below)._
6. **Reroute callers through DB config (blocking paths only).**
   - `routes/chat.ts` builds `CompletionOptions` with
     `provider: routingResult.provider` once the router returns a
     `ModelRef`.
   - `CompletionOptions.model` keeps its string form; the streaming and
     blocking call sites otherwise do not change.
   - `titleService` / `metricsService` / guard-classifier callers keep
     calling `inferenceService` unchanged — they get the env-default
     provider implicitly (`groq`). Their migration is task 8's scope
     decision (E), not this task's.
7. **ε-random tier routing in `routerService`.**
   - Change `RouterConfig` to hold `ModelRef[]` per tier sourced from
     `modelConfigService.listByTier`, with the env single-model as the
     degenerate case (the fallback `listByTier` already returns).
   - When a tier has ≥2 entries, pick ε-randomly; when 1, deterministic as
     today. ε via env (`ROUTER_EPSILON`) with a fixed default; seeded into
     config once at startup, overridable in tests via a seeded PRNG.
   - **This task is hard-gated on Open question D** (ε semantics and
     guard-model pool membership). Do not start it. Deterministic-path
     work in tasks 4–6 proceeds meanwhile.
8. **Migrate remaining callers (`titleService`, `metricsService`, guard
   call inside `routerService`) to the central service; delete dead
   connector code.**
   - Guard classifier call stays functionally identical (same prompt,
     temperature 0, `max_tokens: 10`), only routed through the new
     surface, and — per D — must not yet be pulled into the DB-pool
     ε-selection.
   - Scope of "reimplement in Mastra" for these callers is E: unless the
     user pins a broader reading, this task limits itself to the
     call-site/provider swap and does not convert `titleService` or
     `metricsService` internals into Mastra agents/workflows.
9. **Tests.** Existing suites keep passing with mocked `inferenceService`
   (they already do exactly that in `chat.test.ts` / `chat.stream.test.ts`)
   — but see above: the transport mocks must move to the new module
   boundary in task 5, not stay pointed at the old import path.
   Also: verify `require('@mastra/core/agent')` actually loads inside a
   jest worker in this repo (spike proved it in Node directly —
   open question I-residual).
   Add: neutral-type mapping round-trips, DB-config selection,
   ε-random determinism with a seeded PRNG, DeepInfra path exercised at
   least in a mocked unit test, and a test that `Message.modelName`
   records the **chosen** model when the pool is non-trivial.
10. **`npm run ci`, fix fallout, update `docs/progress.md`.** Check jest's
    config handles any ESM-only `@mastra/*` transitive imports before
    declaring done — a CI-green `/test` with a skipped-or-crashed stream
    test would silently shed the SSE coverage.

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

## Open questions

A, B, C, H and I were resolved empirically by the task-4 spike (results
recorded in the "Task-4 spike results" section below and posted to issue
#4); they are removed from this section — the detailed steps in tasks 5
and 9 now carry them as facts plus the residual verifications. Of the
remaining items, D, E, F and G have been posted to issue #4 already.
No in-flight task assumes an answer to any unresolved item:

- **D. ε-randomness semantics:** default ε value; randomness within a tier
  only, vs across tiers when the classifier is uncertain; and whether the
  guard classifier model moves into the DB pool too (its env default
  `allam-2-7b` has no provider prefix — no confirmation it is even a Groq
  model). Task 7 waits for this.
- **E. Scope of "reimplement in Mastra":** does non-chat LLM work
  (`titleService` categories, `metricsService` classifier) become Mastra
  agents/workflows, or only route through the centralised service? "Where
  it makes sense to" is subjective; conservative reading is
  orchestration-only and that is what task 8 implements unless the user
  pins a broader reading.
- **F. Stale env-seeded rows** _(posted; task 2 already shipped, so this
  affects a follow-up, not a live task)_: seed rows copy the env-model
  values at first-read time. If an operator later changes
  `ROUTER_SMALL_MODEL`/`LARGE`, the DB keeps the old identity and routing
  never sees the new value (only brand-new empty DBs re-seed). Intended,
  or should env overrides always apply until a row is explicitly edited
  (e.g. compare/refresh or a `seededFromEnv` flag)?
- **G. Ineligible-tier fallback semantics** _(posted; same note as F)_:
  when every DB entry for a tier is `eligible: false`, we currently fall
  back to the env model for that tier. Confirm that is the desired
  behaviour vs. returning an empty list (which would force routing to fail
  loudly instead of silently using an exit-path model).
- **H-residual. Real-provider smoke** _(posted; new in this pass)_: the
  spike verified A–C only against a local mock server. One observed
  behaviour: a stream with no proper finish chunk produced
  `finishReason: 'other'` and Mastra retried the whole call (≈5 requests).
  With real Groq/DeepInfra endpoints this raises a question the mock could
  not answer: does Mastra retry transparently on a mid-stream transport
  failure, and if so does the retried attempt re-emit text deltas into the
  same `fullStream` (which would duplicate text in our `/api/chat/stream`
  SSE stream and, worse, stream duplicate deltas into a single persisted
  `Message`)? If so, we need to know the default retry policy and how to
  disable it for unbounded streaming before `mastraService` lands. This
  is empirical (needs real endpoints/keys) and is folded into task 5's
  real-provider smoke step rather than blocked on beforehand — but it is
  recorded as genuinely unknown, not assumed away.
- **I-residual. jest transform for `@mastra/*` inside a worker** _(partially
  resolved; kept open for honesty)_: the spike proved CJS `require`
  works in bare Node, but that is not the same as ts-jest's transform
  pipeline loading it inside a jest worker. Verification is scheduled as
  the first act of task 5's commit (and rechecked in task 9); the
  fallback — a DI seam so tests mock the central service without loading
  `@mastra/core` — is a decision task 5 makes deliberately if the
  require-path check fails there, not by accident in task 10.

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
input still pending; none of tasks 5–6 depend on them). This revision adds
H-residual (retry/duplicate-delta behaviour on real endpoints) and I-residual
(ts-jest worker check) — see the Open questions section.

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
