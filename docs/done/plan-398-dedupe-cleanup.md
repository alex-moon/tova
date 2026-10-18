# Plan 398 — dedupe / dead-surface cleanup batch (server)

## Motivation

[Issue #398](https://github.com/alex-moon/tova/issues/398), from the #382 audit. Server-side duplication and dead surface that doesn't belong on the other audit tickets. Validated against the current tree on 2026-10-18: all items still present except 10(b) (racingService removed), 10(c) (filesLikely removed), and 13(d) (manageCommands deep-import fixed).

## Decisions

- The `sanitizeFilename`/`sanitizeZipEntryName` pair is explicitly assigned to #396 in the issue text — out of scope here to avoid colliding with PR #411.
- Aux-classifier wrapper: one `auxCompletion` helper owning the lazy `config.aux` read, structured call, error log, and catch-to-null; per-service prompts/schemas stay in the services. A completion without `object` is a connector contract breach and resolves null, so each service's fallback path also covers post-processing failures (the old catch-all did). One shared quote-strip regex (straight + curly + backtick) ends the drift.
- Provider registry: `inferenceService` stays the single registry and tally choke point (`recordModelError`); compare/evals read connectors from it so `ModelRouteError` counting stops being bypassed. Admin route derives its provider list from the same source. modelCompare keeps its `Unknown provider: X` row message (tests pin it).
- Tool-chip builders: moved the tool-event serialization cluster (`toolLabelFrom`, `toolCallEvent`, `toolResultEvent`, `reconcileToolEvent`, `PersistedToolEvent` + private helpers) out of `routes/chat.ts` into `services/toolChips.ts`; `chat.ts` re-exports for its tests. Fixes the service→route and model→route import inversions.
- Dead exports are un-exported (not deleted) when the symbol is internally used; fully deleted when nothing uses it. Tests exercising removed surface (chat-scoped `WorkspaceStorage` methods) go with the surface.
- The two `STOPWORDS` sets turned out to be different vocabularies (retrieval vs metric tokenisation), so they were renamed purpose-specifically (`RETRIEVAL_STOPWORDS`/`METRIC_STOPWORDS`) instead of merged — merging would change behaviour.
- Regex ritual in `promptMetrics`: use `text.match(RE)` directly — with `/g`, `String.prototype.match` re-collects all matches and carries no `lastIndex` state.
- `agentCache` in `mastraService`: insertion-order cap of 50 entries (Map preserves order); evict oldest at the cap. Agent id/name gains the model (slug-safe) so traces distinguish models.
- LangSmith dataset export: shared duck-typed client + `ensureDataset` in `langsmithDataset.ts`, each exporter keeping its own policy (append-on-rerun vs delete-then-recreate). `tracePurge` now runs its query path through `queryRuns` (429/5xx retries) and reuses `headersFor`/`resolveProject`; the delete call stays a plain fetch (response body need not be JSON). The purge test's injected failure moved from 429 (now retried, by design) to 400 to keep exercising per-session isolation.
- `MAX_STORED_ERROR_CHARS`/`clampError`: single home in `clampError.ts`, imported by evals, memory evals, tasks, and asset jobs.

## Done

- [x] Shared `auxCompletion` helper; five services on it; quote-strip drift fixed
- [x] `metricsService` truncates content sent to the aux classifier (matches honestyGuard cap)
- [x] `adminGuard` exported from `middleware/auth.ts`, four route files use it
- [x] `zodMessage` helper replaces 17 `.issues[0]?.message ?? fallback` sites across 7 route files
- [x] Cursor pagination helper shared by tasks + assets routes
- [x] Single `withTimeout`; `textExtraction` imports `extensionOf` instead of its copy
- [x] Provider registry unified (compare/evals route through the tally); admin `PROVIDER_SET` derived
- [x] `auth.ts`/`index.ts` read env via `config` (googleOAuth/runtime live again)
- [x] Tool-chip cluster in `services/toolChips.ts`; `TaskEvent` no longer imports from routes
- [x] Dead surface removed: SYSTEM_PROMPT export, dup EmbeddableKind, unused exports un-exported, `ToolCallRecord.result`, chat-scoped WorkspaceStorage methods, unreachable `documentUnits` branch, no-op eval filter, dead `EvalResult`, STOPWORDS renamed
- [x] `promptMetrics` regex ritual removed
- [x] Eval-run dedupe: MAX_STORED_ERROR_CHARS/clampError single home, shared LangSmith dataset client, single `sleep`, `tracePurge` on shared plumbing
- [x] Small ones: rerankDocText uses withEmbedTitle, single 12k constant, first-hop SSRF dedupe in fetchPage, agent id/name includes model, agentCache bounded
- [x] `npm run ci` green

## Follow-ups

- None yet.
