# Delivery Log

## Status (current)

#168 Model errors disable the model (branch `feat/tv/168-170-model-pool`): a
qualifying endpoint failure immediately cools the model off
(`providerroutings.disabledUntil`, 6h default via `MODEL_COOL_OFF_HOURS`, lazy
expiry on read). Both chat paths (streaming and non-streaming) disable →
re-route → retry up to MAX_ATTEMPTS; a failed cool-off write stops the loop
with the original error; 429/413/client-aborts never cool off — 429 is
deliberately back-off territory (#178) and fails the turn loudly with the
retry-hint message instead of draining the pool. A fully cooling-off pinned
pool throws `AllModelsDisabledError` (three-case `listByTier`, NO env
fallback) and both routes surface it as 503 with the friendly message; the
router defers the tier's all-disabled error to pick time so the healthy tier
keeps serving, and reports drained pools on image turns as all-disabled
rather than a config gap. Diagnostics consolidated lean (OQ-7, decision
2026-09-26): #175's `modelrouteerrors` tally at the inferenceService choke
point is the single mechanism — the admin Models tab shows a cooling-off
badge and an errors table reading that collection; no second stats service.
Builds on #173 (cool-off scaffolding) and supersedes PR #177. Follow-ups
filed: #178 (429 back-off), #179 (persistent log retention).

#170 More models (in flight, branch `feat/tv/168-170-model-pool`, was
`feat/170-more-models`/PR #180): 14 more DeepInfra
models seeded into the large completion tier so the admin elimination process
has candidates to evaluate on live traffic. ZDR-only selection — no
Google/Anthropic partner models (the only retention exceptions on DeepInfra);
13 rows are >170b total params, plus the 70-170b bucket's one representative
(Nemotron-3-Super-120B, known to 429 "Model busy" intermittently — capacity,
covered by #168 cool-off; keep/drop is OQ-2 on the ticket). Capabilities from
the live catalog + probes (2026-09-26): all 14 accept OpenAI-style `tools`; 8
are vision rows (accept `image_url` parts in the same request) growing the
image-turn pool 2 → 10. Delivered as `SEED_ENTRIES` rows + seed tests (pool
10 → 24 docs) + `$setOnInsert` migration `20260926000200-seed-more-models-
routing.ts` + migration test — admin deletions after migration stick, and
`eligible: true` means the batch takes real routed traffic immediately under
uniform ε-exploration. #158 sweep universe grows 9 → 23 eligible rows (full
sweeps proportionally costlier). Discovery logged for a follow-up: Maverick
and Qwen3-VL-8B are delisted from the DeepInfra catalog but still serve via
legacy aliases. `npm run ci` green.

#148 E2E expansion (branch `feat/148-e2e-expansion`): local Playwright was failing because
`e2e/playwright.config.ts` never loaded `.env` (a one-line `import 'dotenv/config'` was the
sole root cause — suite went 16/16 green immediately). Added stable `data-testid` hooks to
Login and the ChatWindow composer, extracted the mocked SSE stream into
`e2e/helpers/chatMock.ts` (shared by all chat specs), and added three specs: `auth.spec.ts`
(login/error/reload/logout, real local endpoints, read-only), `chat.spec.ts` (send + streamed
multi-delta reply), and `profile.spec.ts` (profile-save PATCH contract plus the ZDR request
contract — `history` without `sessionId` on, `sessionId` without `history` off — fully
page-mocked so no real user state is mutated). Suite is 30/30 across mobile/desktop;
`npm run ci` exit 0.

#116 ZDR option (merged via PR #124): a per-user "Zero data retention" toggle
(`settings.zdr`, ProfileModal → `PATCH /api/profile`). With it on: chat turns are
session-less (no Session/Message rows, no title/classification writes), continuity is a
client-replayed capped `history` payload, a request carrying a `sessionId` is rejected
with 409, chat-composer attachments ride a throwaway `ephemeral` flag (row + Spaces
object erased with the turn, including on error paths), Assets-page uploads are
unchanged, first-enable soft-deletes prior sessions and hard-deletes their messages,
and copy states chats/files are never used to train models. Turned off, chat behaves
exactly as before.

#138 Productivity app (in flight, branch `feat/138-productivity-app`): the data
substrate for a per-user entity graph so Tova can reason over entities accumulated
across chats. Minimal back-end per the ticket's "most minimal implementation" —
`entities`/`entityEdges` MongoDB collections with a loose schema (`kind`, `attrs`,
`sourceRefs`) while the ontology is still being settled; post-hoc fire-and-forget LLM
extraction after assistant replies (`entityExtractionService.ts`, titleService-style,
`entity-graph-extract` LangSmith span, degrade-to-log on junk JSON); exact
normalised-name node identity, edges only for stated relationships; retrieval injects
a capped (~1500 char) "what we know about you" block into the system prompt
(`entityRetrievalService.ts` + promptAssembly); admin read-only "Graph" tab lists a
user's nodes paginated and drills into a node's edges with source refs for audit.
Everything is behind `ENTITY_GRAPH_ENABLED` / `ENTITY_GRAPH_PROMPT_INJECTION`
(default off) — no prompt-path behaviour change until the flags are flipped.
Preference inference, fuzzy disambiguation, ontology enforcement, files feeding the
graph and tool-based querying are deliberately deferred; open questions in the plan
doc.

#145 Log redaction (in flight, PR #154): `logRedaction.ts` (`redactForLog`) redacts
error message text at every user-content-adjacent `console.*` call site (verified
hit-by-hit audit of `src/server`), protecting stdout and the admin logs buffer via the
logService console capture; `traceRedaction.ts` applies the same policy to LangSmith
span input/output/error via an exporter override; pino evaluated and declined (call-site
redaction covers the actual failure mode; documented in the plan). Gate: RAG notes
ticket can now state the no-leak constraint in `docs/overview.md`.

No outstanding local tasks. Planning and tracking happen on GitHub (`alex-moon/tova`):
issues for open work, PRs for changes; plans live in `docs/plan-<ticket>-<summary>.md`
per `docs/workflow.md`.

- Runnable product state: local end-to-end workflow documented in the root `README.md` (MongoDB via `npm run stack`, migrations via `npm run migrate`, backend and frontend on the host).
- Quality gate: `npm run ci` — lint, format, typecheck, server tests, client lint/format/tests/build.
- Model routing contract: documented in the root `README.md` ("Model Routing Contract").
- Per-message prompt metrics: fixed as of this entry. Every new turn gets a `metrics` subdocument (deterministic for user + assistant; LLM-classified dimensions for user messages, fire-and-forget post-save). Inspect with:
  `npx tsx scripts/mongo.ts "await db.collection('messages').find({ 'metrics': { $exists: true, $ne: null } }).sort({ timestamp: -1 }).limit(3).toArray()"` — or filter for pending LLM classification with `{ 'metrics.llm': null, role: 'user' }`.

#112 Evals (in flight): deterministic tool-use grader (`src/server/evals/`), golden
set in `cases.ts` (GitHub README two-tool chain, Bupa policy list-then-read,
PM-announcements web search, plus wrong-tool/save-file extras), temporary Mongo
source seeded by `mongoSource.ts`, runner `scripts/run-evals.ts` (`npm run evals`)
streaming the real agent and grading pass/partial/fail, LangSmith export to the
`tova-evals` dataset when `LANGSMITH_API_KEY` is set. No client changes.

7. **Plan 004/#4 — Mastra + DeepInfra + DB-based tier routing (complete).** All LLM calls go through `mastraService` (sole `@mastra/*` importer) with
   thin Groq/DeepInfra connectors behind `inferenceService`; tier pools live
   in MongoDB (`providerRouting`, seeded from `ROUTER_*` envs once, DB
   authoritative after); `routerService` picks ε-uniformly within a tier
   (`ROUTER_EPSILON` default 1, one eligible model → deterministic, none →
   throw). Live-provider smoke (keys in `.env`) caught and fixed two real
   bugs: the stream mapper read a non-existent flat `delta` field (real
   chunks are `{ payload: { text } }`), and upstream error chunks were
   silently swallowed (now rethrown → SSE `error` event). Empty provider
   responses persist `content: ''` (`Message.content` presence-validated);
   the UI shows `(no content returned)`. Reasoning models on Groq spend
   hidden reasoning tokens from `max_tokens` — `titleService` budget
   raised 30 → 512 after live verification. `npm run ci` green.

8. **#34 — Asset library: uploads to DigitalOcean Spaces via presigned URLs (complete).**
   Browser uploads go directly to Spaces (AWS SDK v3 signed against the
   `lon1` endpoint; region absent from `.env` initially, confirmed `lon1`
   empirically against the real bucket and set in `.env`/`.env.example`);
   the Express server never touches file bytes. New `/api/assets` surface: `presign`
   (allowlist + 15 MB cap, 60 s PUT), `confirm` (real HEAD, size
   reconciliation, light text extraction for `txt`/`md`/`csv` with a
   truncation cap, stale-pending rejection), cursor-paged list, 5-min
   presigned GET URLs, delete converging on missing objects (NoSuchKey
   treated as deleted). Ownership isolation tested; S3 interactions mocked
   in CI (no live dependency). Client: "Files" panel in the sidebar
   (drag-drop upload, icon-only cards — never rendering contents —
   download, delete) and a composer paperclip attach flow feeding one
   `assetId` per message into `/api/chat/stream`; the send path pastes
   extracted file text into the prompt in a delimited block (truncated)
   while stored message content and text-only behavior stay unchanged.
   Owner asked "no extracted text" to be user-visible: confirm carries
   `hasText` and the composer toasts the marker. Verified end-to-end
   against the real `tova` Space in `lon1` (presign → PUT → confirm →
   list → GET-back → delete, guest blocked). No DB migration required
   (new collection, optional `Message.assetId`; indexes from the schema).
   `npm run ci` green.

9. **#80 — MCP setup: token-only auth + collapsible scope list (in progress).**
   Add flow asks for a raw `authToken` instead of a full
   `Authorization: Bearer …` header: the schema field is now `authToken`
   (`mcpServerCreateSchema`, strictObject so old `authHeader` payloads are
   rejected) and the server wraps it as `{ Authorization: 'Bearer <token>' }`
   into the same encrypted headers envelope — storage shape, model, and
   `mcpService` are unchanged. UI input is a password-type token field
   (`mcp-add-auth-token`); the per-server tool list is collapsed to an
   "N scopes" toggle (`mcp-show-scopes-<name>`, aria-expanded) that expands
   to the full tool-name list. Crypto cleanup of the dead `encryptHeader`/
   `decryptHeader` pair done; crypto.ts now has a single key scheme.
   Rationale kept for the PR: bcrypt (one-way)
   cannot replace the encryption — tokens must be replayed verbatim in
   request headers.
   Add flow also gained a collapsed "show suggestions" block: a curated
   popular-MCP-servers list (remote HTTP endpoints only, mirroring the
   community awesome-mcp-servers catalog) with lucide icons; clicking one
   prefills name/URL in the add form (`mcp-show-suggestions`,
   `mcp-suggestion-<n>`).

## Delivery History (summary)

1. **Plan 001 — Reconcile root tooling and doc status.** Aligned the documented workflow, root tooling, and runnable entry points.
2. **Plan 002 — Stabilize server runtime and dependencies.** Backend boots reliably; dependency set is complete and supported.
3. **Plan 003 — Make the unified dev workflow runnable.** Host processes + dockerized MongoDB (`npm run stack`), migrations seeded an email-based admin, `dev`/`dev:server`/`dev:client` and the command table were established.
4. **Plan 004 — Add streaming chat responses.** `POST /api/chat/stream` (SSE) with `meta`/`delta`/`done` events; the client renders replies progressively; persistence unchanged; streaming tests added.
5. **Plan 005 — Expand router evaluation and tests.** Router test suite grew from 3 to 12 tests covering every deterministic and classifier branch plus fallbacks; `POST /api/chat` gained a routing-metadata test (`routing: { model, reason }`, `modelName` persistence); the routing contract is documented in the root `README.md`.
6. **Plan 017 — Collect per-message prompt metrics.** `metrics` subdocument on messages (deterministic features via `promptMetrics.ts` for both roles; guard-model LLM classifications via `metricsService.ts`, fire-and-forget post-save, nulls on failure); wired into both chat endpoints; unit + route/stream integration tests. Model-eval pass on DeepInfra (20 fixed prompts, production parser): picked `google/gemma-3-4b-it` (20/20 parse, lowest latency, no truncation) for when #4 wires the DeepInfra connector; Qwen3.5-9B ruled out (100% truncation at max_tokens 100).
7. **Plan 149 — Workspace file-storage abstraction boundary.** `WorkspaceStorage` interface + `spacesWorkspaceStorage` over the existing Spaces driver (`workspaceStorage.ts`, incl. `RawKeyStorage` for assets and `SpacesCapabilities`); all call sites rewired; ESLint `no-restricted-imports` guard makes the boundary physically enforced; chat-scoped key layout `<userId>/chats/<chatId>/<filename>` kept structurally disjoint from asset keys; no behavioural change.

A more detailed historical log with artifact lists is preserved in the git history of this file. The compact summary above is the canonical narrative.

## Context

Early history (pre-process formalization): backend auth and data-persistence foundations, the router service, the React chat UI and session flows, and partial Docker/local-development support existed.

## Pointing Forward

- Open work lives in GitHub issues; do not recreate a local queue.
- The local docs stay static: `docs/overview.md` for product intent, this file for status and history, and this repository's `README.md`/`AGENTS.md` for workflows and agent rules.
