# Plan — feat/tv/4-mastra-implementation (Mastra + DeepInfra, DB-based routing)

GitHub issue: https://github.com/alex-moon/tova/issues/4

## Motivation

The issue asks for two things:

1. **DeepInfra integration + DB-based provider/model routing.** Today every
   turn goes through `routerService.routeQuery` → one Groq model
   (small/large/guard via `ROUTER_*` envs). We want multiple providers and a
   model pool stored in MongoDB, with routing based on the existing
   small/large classifier plus some randomness, so real feedback data starts
   accumulating.
2. **Mastra.** Re-implement the LLM-touching parts of the app on
   [Mastra](https://mastra.ai) where it earns its place, centralising all
   Mastra imports in a single service, with Groq and DeepInfra relegated to
   small provider classes behind it.

The later, edited version of the issue body references a different (broader)
set of suggestions (catalog, query enhancement, tool loops). The **current**
body shown at the top is the authoritative one; everything else is delegated /
followed up outside this ticket.

## Current state (verified from the repo, as of branch start)

- `src/server/services/inferenceService.ts` — a hand-rolled `LlmConnector`
  interface wrapping `groq-sdk`, with a single hard-wired Groq connector and
  a comment explicitly pointing at #4 as the place to add DeepInfra.
- Callers of `inferenceService`: to be confirmed at implementation time via
  grep (`routerService`, `titleService`, `chat` route streaming expected).
- `src/server/services/routerService.ts` — deterministic small/large routing
  plus an env-configured guard model; persists `modelName` on the assistant
  message.
- No `mastra` package anywhere in `package.json` or `node_modules`.
- No DeepInfra client code, no MongoDB-backed model/provider config.
- SSE contract on `/api/chat/stream` and `Message.modelName` persistence are
  in place and must stay stable.

## Decisions so far

- **Mastra as the orchestration layer, not a rewrite of the framework:** the
  routes, auth, MongoDB models, and SSE contract stay as they are; only the
  LLM-call paths move behind Mastra.
- **Single point of Mastra imports:** one service module (evolving the
  existing `inferenceService` or a sibling `mastraService.ts`) that
  re-exports/encapsulates all `@mastra/*` imports. Provider classes (groq,
  deepinfra) must not import mastra directly.
- **Providers get smaller:** both provider classes should end up as thin
  adapters (base URL + API key + model listing) — Mastra's provider
  integration handles the completion/streaming mechanics.
- **Routing config in MongoDB:** a small collection (e.g. `providers` /
  `models` docs) seeded with Groq and DeepInfra entries; env-vars remain as
  fallback for the guard model until further notice.
- **Randomness for feedback:** when several models qualify for a classified
  tier (small/large), pick one with a modest ε-random spread instead of
  always the first, so per-model feedback becomes meaningful. ε configurable
  via env with a sane default.
- **Contract stability:** `/api/chat/stream` SSE event set unchanged;
  `Message.modelName` records the model that actually ran.

## Checklist

Small, individually commit-safe tasks:

- [ ] 1. Research & pin Mastra packages: confirm current `@mastra/core`
  major, the supported DeepInfra provider path (official package vs
  OpenAI-compatible base URL), and record in this doc's Open questions are
  resolved or moved to follow-ups.
- [ ] 2. Add a `providerRouting` MongoDB collection + a tiny
  `modelConfigService` (list eligible models by tier; seed Groq/DeepInfra
  docs on first run). Unit tests with mocked DB.
- [ ] 3. Build the two thin provider classes (`GroqProvider`,
  `DeepInfraProvider`) behind a shared interface, backed by Mastra model
  providers; keep all `@mastra/*` imports inside the centralised service.
- [ ] 4. Replace the hard-wired `groqConnector` in `inferenceService` with
  provider instantiation through Mastra, selected via
  `routerService` + `modelConfigService`.
- [ ] 5. Add ε-random tier routing in `routerService` (respect the guard
  classifier input) and persist the actually-chosen `modelName`.
- [ ] 6. Migrate `titleService` and any other direct completion callers onto
  the new central service; delete dead connector code.
- [ ] 7. Update/extend tests: existing suites keep passing with mocked
  providers; add coverage for DB-config routing, ε-random behaviour, and
  DeepInfra fallback.
- [ ] 8. Run `npm run ci`, fix fallout, update `docs/progress.md`.

## Verification

Per repo convention: `npm run lint`, `npm run typecheck`, `npm test`,
`npm run ci` at the end. No end-to-end provider keys are assumed in CI;
provider calls are behind mocked interfaces in tests.

## Follow-ups

- Wiring per-message feedback collection to actually consume the ε-random
  multi-model data (the issue's stated goal) — likely its own ticket once
  data starts flowing.
- Possibly retiring `ROUTER_SMALL/LARGE/GUARD_MODEL` envs once the DB config
  is proven, with a migration for existing deployments.

## Open questions

- **Mastra + DeepInfra support surface:** does the current Mastra release
  ship a first-class DeepInfra provider, or should we go through its
  OpenAI-compatible endpoint? (Affects task 1 and the size of
  `DeepInfraProvider`.) Not yet verified.
- **Server-run Mastra vs client-side agents:** the app is a plain Express +
  React app; Mastra's agent runtime runs server-side here — confirm
  no assumptions about Mastra's dev server / registries are needed for our
  use case.
- **Streaming through Mastra:** confirm Mastra's streaming output maps
  cleanly onto the existing SSE envelope without changing the event
  contract; if not, adaptation stays in the centralised service only.
- **How much ε-randomness:** default value and whether randomness applies
  only within a tier vs across tiers when the classifier is uncertain.
