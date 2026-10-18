# Plan: Retire the model roster — CHAT_MODEL / TASK_MODEL env vars (#387)

Ticket: https://github.com/alex-moon/tova/issues/387
Touchpoint map: the #382 audit comment on the ticket (authoritative file:line list).

## Intent

Every function in the codebase now has a chosen model. Retire the roster/racing
data layer and pick models from env: `CHAT_MODEL` (default
`zai-org/GLM-5.3-Flash`) and `TASK_MODEL` (default
`deepseek-ai/DeepSeek-V4.1-Flash-1017`). Chat still races the providers that
serve the chosen model; tasks pin DeepInfra (DS4.1F is not maintained on
Fireworks and the unversioned id is priced higher there). TTFT stays as
diagnostics only. Tasks get a lean tool-use system prompt and
`toolChoice: 'required'`.

## Design

- **New `services/modelDefaults.ts`** — single source for the retirement:
  - `CHAT_MODEL` / `TASK_MODEL` env reads (defaults per ticket).
  - `CHAT_BACKENDS`: known (provider → provider-specific model id) map for the
    two default models, taken from `ROSTER_SEED` (GLM-5.3-Flash on deepinfra +
    fireworks; DeepSeek on deepinfra + fireworks). An unknown `CHAT_MODEL`
    override races nothing: it rides deepinfra verbatim.
  - `MODEL_CONTEXT_LENGTHS`: static context table (both defaults 1048576) so
    `outputTokensFor` keeps working without the roster.
  - `MODEL_PRICES`: static (model, provider) → USD/1M price table feeding
    `traceStatsCost` (replaces `listRoster()` as the price source).
- **New `services/chatRace.ts`** replaces `racingService.ts` — keeps the hedged
  race mechanics (fire every backend of CHAT_MODEL, first token/resolution
  wins, losers aborted), drops roster reads, cool-offs, pickPrimary, TTFT
  persistence. Race seams (`startStream`/`startCompletion`) are the test hooks.
  Routing result: `{ model: CHAT_MODEL, provider: winner, reason,
  contextLength }` with reason `fixed-model;ttft:N` (stream) / `fixed-model`.
- **Chat routes** — pre-pick collapses; `max_tokens` sizes against the static
  context (kills the pre-race/winner mismatch, audit 4.2); SSE `meta` is sent
  after the race resolves (before any delta) so it names the provider that
  actually serves the turn; `AllModelsDisabledError` 503 paths collapse to the
  generic 500.
- **Tasks** — `runTaskStep` calls `inferenceService.createCompletion` directly
  with `{ provider: 'deepinfra', model: TASK_MODEL }`; step runner seam
  re-homed (`TaskStepDeps`). New `toolUse?: 'required'` on `CompletionOptions`,
  honoured in `mastraService` (`toolChoice: 'required'`, Mastra 1.66 supports
  it). New `task` tools mode: lean task-only system prompt (tool use, no
  personality) and the toolset minus `delegate_task` (it can never succeed from
  a task — no sessionId). Step latency logged (TTFT diagnostics for tasks).
- **Cost + stats** — `traceStatsCost.loadPriceIndex` builds from
  `MODEL_PRICES`; `sessionCostService` unchanged (same index API).
- **Admin API** — `GET /models` becomes read-only `{ models: fixed serving
  models, errors: tally }`; CRUD (POST/PUT/DELETE) dies; `/model-lookup` and
  `/model-compare` survive; compare's provider set drops the dead `typesafe`.
- **Client (AdminView)** — Models tab becomes a read-only serving-models +
  error-tally table; CRUD UI dies; Compare tab seeds from the fixed models.
  Mobile-first verification with playwright at 375px.
- **manageCommands** — `roster` command dies; probe targets re-pinned to the
  chat backends table.
- **Evals** — `sweepModels('all')` enumerates the deduped backend pairs of
  CHAT_MODEL + TASK_MODEL; `defaultEvalRef` → CHAT_MODEL on deepinfra;
  memory-eval responder fallback → CHAT_MODEL.
- **Migration** — new migration drops `modelrosters` (up); down re-seeds the
  two seed rows for reversibility.
- **Env vars retired** — `ROSTER_DEFAULT_TTFT_MS`, `ROSTER_PRICE_PENALTY_K`,
  `ROSTER_TTFT_WINDOW`, `MODEL_COOL_OFF_HOURS`,
  `MODEL_OVERLOAD_COOL_OFF_MINUTES`. Groq keeps serving aux calls (title,
  subtitle, followups, guards, metrics) — out of this ticket's scope.

## Not in scope

- #391 (chat handler dedup) — separate ticket, do right after this one.
- #394 (`TOVA_EVAL_PROVIDER` provider+model pairing bug) — semantics preserved.
- Dropping/isolating groq or flipping the untagged provider default.

## Decisions

- **Price index covers every priced model, not just the two defaults.**
  `buildPriceIndex` iterates `pricedModels()` (all keys of `MODEL_PRICES`), so
  traces carrying the pre-retirement unsuffixed DeepSeek id keep cost
  estimates; genuinely unknown models still estimate as null.
- **Retired `typesafe` tests collapsed into the unknown-provider paths.** The
  `LlmProvider` union drops `typesafe`; inferenceService's unknown-provider
  suite already pins the loud-failure behaviour, and modelCompare keeps one
  cast error-row test for a retired id.
- **Task step latency (TTFT-equivalent) logged, not persisted** — the task path
  is non-streaming, so the logged wall-clock step time is the diagnostic.
- **Review hardening: the completion race aborts losers** (draft-PR review).
  `raceRosterCompletion` failed over sequentially, so the parallel
  `raceChatCompletion` silently changed semantics: a losing completion ran the
  full agent loop to resolution in the background — duplicate tool side
  effects (a second `delegate_task`/`generate_file`) and double token spend.
  Losers now get per-attempt abort controllers aborted on the win, mirroring
  the stream race; an all-fail surface prefers an actionable provider error
  over a client abort (`isClientAbort`), as the old race did.
- **Coverage hole from the draft: `chatRace` had no direct tests** (the route
  suites mock the race). New `chatRace.test.ts` pins winner-claim, loser
  self-abort, loser abort on stream end, empty-stream fall-through, client
  abort propagation, and the all-fail error pick — stream and completion.

## Done

- [x] `modelDefaults.ts` (CHAT_MODEL/TASK_MODEL env, backends, context, prices, sweep)
- [x] `chatRace.ts` hedged race replaces `racingService.ts`; roster, cool-offs, TTFT persistence dropped
- [x] Chat routes pre-pick collapse, max_tokens vs static context, SSE meta after race
- [x] Tasks pin deepinfra/TASK_MODEL with `toolUse: 'required'`, lean task prompt, no delegate_task
- [x] Cost/stats off static price table; admin GET /models read-only; CRUD routes die
- [x] Client Models tab read-only; Compare seeded from fixed models; mobile-verified at 375px
- [x] `roster` manage command dies; eval sweep over deduped backend pairs
- [x] Migration drops `modelrosters` (down re-seeds the two rows)
- [x] Retired roster env vars; client tests rewritten; `npm run ci` green; e2e 60/60
- [x] Draft review: completion race aborts losers; chatRace test suite; docs/env drift fixed

## Verification

- `npm run ci` green locally; reworked tests: chat routes (5 files mock the
  race), taskSequencer, evalRunService, modelConfigService, traceStatsCost,
  sessionCostService, admin, manageCommands; deleted: racingService,
  rosterConfig, migrationSeed drift tests; new: `chatRace.test.ts` (the race
  mechanics, direct).
- Playwright phone-viewport check of the reworked admin Models tab.
