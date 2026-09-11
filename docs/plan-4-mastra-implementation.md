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

## Checklist

Concrete, individually commit-safe steps:

1. **Feasibility spike: pin Mastra packages (research, no app code).**
   - `npm view @mastra/core version` and installability check against this
     repo's Node/ESM setup (`src/server` is TS compiled via tsx/jest —
     verify module resolution, no ESM-only breakage).
   - Identify the provider path used: official `@mastra/*` integration
     packages (if any) for Groq and DeepInfra, vs Mastra's generic
     OpenAI-compatible provider fed with each provider's `baseURL`.
   - Decide and record here whether DeepInfra uses an official package or
     OpenAI-compatible mode; unblock tasks 3–4. **Depends on Open
     question A.**
   - Measure transitive dependency size/behaviour (Mastra may pull a dev
     server or registry machinery we do not need); sketch what we can safely
     not use. **Depends on Open question B.**
2. **`providerRouting` collection + `modelConfigService`.**
   - Schema: `{ provider: 'groq'|'deepinfra', model: string, tier:
'small'|'large'|'guard', eligible: boolean }` (exact shape finalised at
     implementation).
   - Seed on first read: current env defaults as Groq entries, one DeepInfra
     small/large model per pinned research.
   - API: `listByTier(tier) -> ModelRef[]`; falls back to env-based single
     model if the collection is empty (keeps existing tests honest).
   - Unit tests against an in-memory/mocked Mongo per existing test style in
     `routerService.test.ts`.
3. **Centralised Mastra service + two provider classes.**
   - New `src/server/services/` module (e.g. `mastraService.ts`) owning all
     `@mastra/*` imports; `GroqProvider` / `DeepInfraProvider` as thin
     adapters exposing `createCompletion` / streaming, behind
     provider-neutral types (not `Groq.Chat.*` types).
   - Define the neutral result/chunk shapes first so callers can be migrated
     piece by piece without behaviour change.
   - **Streaming mapping is a live risk: depends on Open question C.** Do
     not attempt SSE wiring before C is resolved.
4. **Reroute `inferenceService` through the central service + DB config.**
   - `inferenceService` delegates to provider selected via
     `routerService` + `modelConfigService`; delete the hard-wired
     `groqConnector` once all callers are green.
   - Keep `CompletionOptions` shape stable so `titleService` /
     `metricsService` callers still typecheck; they move to the neutral
     types here or in task 6.
5. **ε-random tier routing in `routerService`.**
   - Extend `RouterConfig` with a list of eligible models per tier; when ≥2
     qualify, ε-randomly pick; otherwise deterministic as today.
   - Persist the actually-chosen model name (routes/chat.ts already does;
     verify `Message.modelName` records the _chosen_, not the default).
   - **Depends on Open question D (ε semantics + guard-model handling).**
     Blocked until D is resolved; deterministic-path work in tasks 3–4 may
     proceed meanwhile.
6. **Migrate remaining callers (`titleService`, `metricsService`, guard
   call inside `routerService`) to the central service; delete dead
   connector code.**
   - Guard classifier call stays functionally identical (same prompt,
     temperature 0, `max_tokens: 10`), only routed through the new surface.
7. **Tests.** Existing suites keep passing with mocked `inferenceService`
   (they already do exactly that in `chat.test.ts` / `chat.stream.test.ts`).
   Add: DB-config selection, ε-random determinism-with-seeding, DeepInfra
   path exercised at least in a mocked unit test.
8. **`npm run ci`, fix fallout, update `docs/progress.md`.**

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

None of these are answered anywhere in the issue comments (there is exactly
one, quoting the superseded description). Every item below is genuinely
unknown to the implementation as of this revision.

- **A. Mastra provider surface:** Officially supported `@mastra/*` packages
  for Groq/DeepInfra in the currently-released major, or generic
  OpenAI-compatible wiring? Not yet verified against the actual Mastra
  release; determines provider-class size and task 1's outcome. Nothing in
  tasks 3–4 proceeds on an assumed answer.
- **B. Mastra server-side usage:** Mastra ships agent/workflow machinery
  with assumptions about its dev server/registry/tooling. Our app is plain
  Express; must confirm we can use library pieces without starting Mastra's
  dev server, and whether Mastra's runtime imposes a storage layer of its
  own. Unverified.
- **C. Streaming through Mastra:** Does Mastra's streaming output map
  cleanly onto our chunk shape consumed in `routes/chat.ts` without
  converting the SSE event contract? The current code is typed against Groq
  chunk shapes; adaptation, if needed, must live entirely in the central
  service. Unverified — and the SSE path is the highest-risk piece.
- **D. ε-randomness semantics:** default ε value; randomness within a tier
  only, vs across tiers when the classifier is uncertain; and whether the
  guard classifier model moves into the DB pool too (its env default
  `allam-2-7b` has no provider prefix — no confirmation it is even a Groq
  model). Task 5 waits for this.
- **E. Scope of "reimplement in Mastra":** does non-chat LLM work
  (`titleService` categories, `metricsService` classifier) become Mastra
  agents/workflows, or only route through the centralised service? "Where it
  makes sense to" is subjective; conservative reading is orchestration-only.
  Needs user confirmation before task 6 converts anything beyond a
  call-site swap.

### Critic-pass revision (after first deliverable on this branch)

Only task 2 has shipped so far (`providerRouting` model +
`modelConfigService`; tasks 1 and 3–8 unstarted). Added two hardening tests
and fixed an uncaught-failure bug: a failing `ProviderRouting.find` (dead
Mongo) propagated out of `listByTier` instead of falling back to the
env-configured model. Defaults table (`DEFAULT_MODEL_ENV`) is now the single
source of truth shared by seeding and the env fallback, and concurrent first
reads are covered.

New open questions raised by this pass:

- **F. Stale env-seeded rows:** seed rows copy the env-model values at
  first-read time. If an operator later changes
  `ROUTER_SMALL_MODEL`/`LARGE`, the DB keeps the old identity and routing
  never sees the new value (only brand-new empty DBs re-seed). Intended, or
  should env overrides always apply until a row is explicitly edited
  (e.g. compare/refresh or a `seededFromEnv` flag)?
- **G. Ineligible-tier fallback semantics:** when every DB entry for a tier
  is `eligible: false`, we currently fall back to the env model for that
  tier. Confirm that is the desired behaviour vs. returning an empty list
  (which would force routing to fail loudly instead of silently using an
  exit-path model).
