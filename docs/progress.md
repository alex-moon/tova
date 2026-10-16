# Delivery Log

## Status (current)

#358 prod outage fix (on `main`, 2026-10-16): the first image upload since
#209 shipped OCR killed the backend — `ocr.ts` resolved `TESSDATA_DIR` with a
fixed five-level upward hop that only matches the tsx layout
(`src/main/services`); the compiled layout is `dist/services`
(`rootDir: src/main`), so the prod image read `/assets/tessdata` → ENOENT →
tesseract.js v7 re-threw worker failures from its message handler when no
`errorHandler` option is set → uncaughtException → exit, and the live compose
service had no restart policy, so the backend stayed down. Fixes: tessdata is
now located by walking up from `__dirname` to the vendored copy (pinned by
tests for both layouts), OCR worker failures are contained (`errorHandler` +
`withTimeout` around `createWorker`, which tesseract v7 otherwise leaves
un-settled on load failure), and the live backend gets
`restart: unless-stopped`.

#260 db:sync discoverability (in flight, branch `fix/tv/260-db-sync-friction`):
agents kept reaching for `mongosh`/`mongodump`/`mongorestore` instead of
`npm run db:sync` for three reinforcing reasons, all doc/artifact-level — the
tooling itself works (verified with a real dump → drop → restore round-trip):
AGENTS.md claimed no `mongosh` binary existed when the full toolchain is
installed (agents that checked stopped trusting the doc), the superseded
`scripts/db-dump.sh`/`db-restore.sh` still sat in `scripts/` pointing readers
at "Install MongoDB Database Tools", env vars that don't exist in `.env`
(`MONGODB_DUMP_URI` vs the real `MONGODB_DUMP_URL`), and an interactive
`read -p` prompt that hangs agent shells, and no doc stated that the
`db:*` npm scripts already wrap the binaries. Fixes: both legacy scripts
deleted; AGENTS.md now states the binaries are installed-but-not-the-interface
and names the hand-rolled-command anti-pattern; README notes the wrapping;
the legacy-tarball compat in `db-sync.ts restore()` stays (old-layout
tarballs may still exist) with its comment reworded.

#232–#238 roster epic (merged to `main` via fast-forward, 2026-10-08; plan doc
archived to `docs/done/plan-roster.md`). The `epic/roster` branch delivered the
fixed model roster + hedged provider racing (#232), the tier-era deletion (#233),
roster-backed admin Models/Compare tabs (#234), per-provider cost tracking
(#235), roster eval sweep (#236), LangSmith provider attribution + TTFT (#237),
and relocated aux calls + enrichment pass (#238); #214 (composer attach menu)
also merged into the epic. `npm run ci` green (87 suites, 1073 server tests)
before the merge.

#238 aux calls + enrichment pass (on the `epic/roster` epic branch, not yet
merged to `main`). The four auxiliary LLM calls (chat title, entity extraction,
follow-up suggestions, prompt-metric classification) no longer read the deleted
tier env vars: a single `AUX_MODEL`/`AUX_PROVIDER` source (default
`openai/gpt-oss-20b` on groq — the retired guard model) feeds them all. The
retired guard's `files` enrichment signal is rebuilt as `enrichmentService.ts`:
before a text turn races, a bounded "first tiny fast pass" on the aux model
judges whether the user is likely referring to a library file and, if so,
injects the bounded file-library index into the system prompt (`ENRICHMENT_ENABLED`
kill switch, `ENRICHMENT_TIMEOUT_MS` cap; image and ZDR turns skip it). No new
enrichment signals were invented — expansion awaits the owner's concrete list.
`npm run ci` green (87 suites, 1072 server tests; 18 client files, 236 tests).

#232/#233 fixed model roster + hedged provider racing, then tier-era deletion
(on the `epic/roster` epic branch, not yet merged to `main`). #232 replaced
tier-based smart routing with a fixed three-model roster (`modelroster`
collection, seeded by `migrations/20261008000000-seed-model-roster.ts`) served
on two serverless providers (DeepInfra + Fireworks). A weighted primary pick
(`score = TTFT × price penalty`), per-provider cool-off, and hedged racing
(fire both providers, first token wins, loser aborted, roster fall-through)
live in `rosterConfig.ts` / `racingService.ts`; both chat routes run on racing.
#233 deleted the tier machinery that #232 left coexisting: `routerService.ts`,
`modelMetricsStatsService.ts`, `models/ModelMetricStat.ts`, the tier/pool
seeds, the `routingBand` field and its plumbing, and the tier/epsilon/guard
routing env reads; `modelFailover.ts` reduced to its error-classification
helpers; both chat routes rewired so racing is the only path (an empty roster
surfaces the all-disabled error). `chat.ts` no longer calls the guard
classifier, so raced turns inject no library index (aux/enrichment redesign is
#238). Admin `/models` reads routing rows + the error tally only (the roster
tab is #234). `npm run ci` green (86 suites, 1173 tests); the 8 migrations run
clean on a fresh DB (roster seeded, no tier collections).

#225 Evals admin (merged to `main` via PR #231, plan doc archived to
`docs/done/plan-225-evals-admin.md`): scheduled daily eval runs plus a new
"Evals" admin tab. The existing deterministic suite
(`scripts/run-evals.ts`) is now driven from the server: `evalRunService.ts`
runs the golden set through the real agent, persists a per-run rollup to the
new `evalruns` collection (`migrations/20261007000000-create-eval-runs.ts`,
model `EvalRunRecord.ts`), and best-effort exports to the LangSmith
`tova-evals` dataset. `evalScheduler.ts` (started in the non-test bootstrap
only, gated by `TOVA_EVAL_SCHEDULE=daily`, default-off) fires once a day at
`TOVA_EVAL_HOUR_UTC`; `evalRunsAdminService.ts` + `routes/adminEvals.ts`
expose run history and manual triggers behind the admin guard, rendered by
the client `AdminEvalsView.tsx`. Eval model/provider selection moved behind
`config.evals` (#142). Note: a full-suite `npm run ci` run showed a
load-dependent flake in `modelConfigService.test.ts` (also a 5s timeout in
`profile.purge.test.ts`) that passes in isolation and on re-run — pre-existing
CI-runner contention, unrelated to this change.

#182 branch-sweep rescue — database snapshot tooling: `scripts/db-sync.ts` and
the `npm run db:dump` / `db:drop` / `db:restore` / `db:sync` scripts rescued
from the superseded `feat/168-model-errors` branch (commit `e40b270`, PR #177).
The #168 cool-off feature itself already landed on `main` via
`feat/tv/168-170-model-pool`; only this self-contained tooling was left behind,
so it was cherry-picked onto a fresh branch off `main` without the conflicting
remainder. `db-sync.ts` dumps the source cluster (`MONGODB_DUMP_URL`) into a
`data/db-dumps/` tarball, then drops + restores it into `MONGODB_URL` for local
interrogation; destructive subcommands are localhost-gated unless
`--i-know-this-is-dangerous` is passed. AGENTS.md, README, and `.env.example`
document the workflow.

#186 LangSmith admin view (merged via PR #189, plan doc in
`docs/done/plan-186-langsmith-view.md`): read-only "Traces" tab in the admin
view over the configured LangSmith project — recent root runs (errors-only +
model filters, model/latency/tokens joined from the `llm:` child runs since
chat turns carry no session metadata, per-row deep links into the LangSmith
UI), a drill-down run tree (inputs/outputs as JSON, `chunk:` streaming
artifacts dropped), and a per-model stats rollup aggregated from a windowed
llm-run sweep. Raw-REST service (`langsmithTracesService.ts`) alongside the
`tracePurge.ts` patterns with live-API learnings baked in: `runs/query`
answers `{runs, ...}` with a hard `limit` ≤ 100 per query (route test
enforces the cap), root `total_tokens` reads 0 under `select` so tokens come
from llm children, bursty 429s get a backoff budget (the root-join stats
design hung live for 2+ minutes; the llm-run sweep answers in ~7s), and
every attempt carries a 20s timeout. Routes behind the PAT-friendly admin
guard (`/api/admin/langsmith/*`); contracts + client service + tests both
sides; smoke-tested against real `tova-dev` traces. `TOVA_PAT` (live) vs
`TOVA_PAT_LOCAL` (local) documented in `.env.example`/AGENTS.md. Note:
GitHub Actions has been failing account-wide today (billing/spending-limit
runner startup errors) — this and the #184 merge were gated on the local
`npm run ci` instead; owner action needed on GitHub billing.

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
