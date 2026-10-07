# Plan — #225 Evals admin

Branch: `feat/225-evals-admin`
GitHub issue: alex-moon/tova#225

Status: implemented on the branch (T1–T7); verification recorded below. Open
questions resolved by their flagged fallbacks this pass (see "Resolved open
questions"). A critic pass (see "Critic pass (this pass)") found and fixed two
defects: the rollup model wrote to the wrong collection (`evalrunrecords`
instead of the migrated `evalruns`), and the scheduled/manual rollup path never
exported to LangSmith; both fixed, and the `TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER`
reads moved behind `config.evals` (#142).

## Motivation

The deterministic eval suite (`src/server/evals/`, runner
`scripts/run-evals.ts`, `npm run evals`) already grades a golden set of cases
against the real agent, and — when `LANGSMITH_API_KEY` is set — pushes cases
and graded runs into the `tova-evals` dataset in LangSmith (#112, #158, #159).

What is missing is a **scheduled, queryable history** of those runs and a
place to look at it in-app. The ticket asks for two things:

1. Run the existing evals periodically — "once a day for example, at
   midnight".
2. Pull the results into a new admin section, ideally computed through
   LangSmith and stored in a calculated DB collection.

Today the eval runner is a one-off CLI; its only durable output is the
LangSmith `tova-evals` dataset, which is not surfaced in Tova at all (the
Traces tab reads the *tracing project*, not the eval dataset, #186). The admin
has no view of "did last night's evals pass?".

End goal: a new admin **Evals** tab showing recent suite outcomes
(pass/partial/fail per case and model, over time), driven by a stored rollup
collection so the view does not re-query LangSmith per page load.

## Existing pieces (verified this pass, file by file)

- **Suite**: `src/server/evals/cases.ts` (`CASES`, 10 cases),
  `graders.ts` (`gradeRun`, `normalizeArgs`, `aggregateScore`, `assertRun`),
  `runCase.ts` (streams the connector, accumulates text/tool calls),
  `types.ts`.
- **Runner output shape** (`scripts/run-evals.ts`): a **module-local**
  `type EvalResult = { testCase, model, provider, score, report }`, where
  `score` is `'pass'|'partial'|'fail'|'error'` (stringly typed, `error` only
  in sweep mode). Per-model sweeps via `--models`; pushes to the LangSmith
  dataset `tova-evals` via `RunTree` + `createFeedback('golden-set-assertions',
  { score, comment })`.
- **Types collision (important)**: `src/server/evals/types.ts` **already
  exports** `interface EvalResult { caseId; score; assertions }` (a *different*
  shape) **and** `interface EvalRun` (the *observed* run the graders score).
  The runner's `EvalResult` is a separate local type. Any new rollup
  model/service type must not reuse those names — see Decision 1 and OQ6.
- **Fixtures**: `mongoSource.ts` seeds/clears a reserved eval user
  (`evalUserId = 6f61e78155a5b2c0d3e1f7a2`) plus a handful of assets, in the
  **same** Mongo database the server uses. `clearEvalSource()` deletes only
  the reserved user's assets + user, so teardown does not touch real data —
  but it runs `deleteMany`/`deleteOne` against the live DB, and seeding/clearing
  is **not safe to run concurrently** with itself (two runs share one reserved
  user id). The runner needs `DEEPINFRA_API_KEY`/`GROQ_API_KEY`, local Mongo,
  and (for the web_search case) a Brave key.
- **Scheduling precedent**: in-process `setInterval` poller +
  `startAssetJobPoller` started in `startServer()` behind
  `NODE_ENV !== 'test'` (`src/server/services/assetJobService.ts`, lines
  110–136). It exposes `start`/`stop`/`isRunning`, a busy-guard so ticks do not
  stack, and `.unref()` on the timer. **Note**: `startServer()` never calls
  `stopAssetJobPoller`, and `src/index.ts` registers no SIGTERM/SIGINT handler
  — graceful shutdown is not modelled today, so "stop" exists only for tests.
  No cron library is a dependency.
- **Admin patterns**: `adminGuard = [authenticateBearerOrSession,
  requireRole('admin')]` (see `routes/adminLangsmith.ts:14`), shared wire types
  in `src/shared/contracts.ts`, thin client connectors as plain objects in
  `src/client/src/services/admin.ts` (e.g. `AdminLangsmithService`), tab-per-
  section in **`src/client/src/components/AdminView.tsx`** (a `sectionContent`
  array + `activeSection` state union, line 72/411) with larger tabs extracted
  into their own component (e.g. `AdminLangsmithView.tsx`, rendered at
  `AdminView.tsx:1151`).
- **Migration pattern**: `mongo-migrate-ts` files under `migrations/`; a new
  collection is pre-created with a timestamped migration, guarded by a
  `listCollections` check (see `20260926000000-create-error-logs.ts`).
- **Stored computed collection precedent**: `ModelMetricStat`
  (`src/server/models/ModelMetricStat.ts`) is a small, explicitly-computed
  rollup collection with a module-level comment explaining why.
- **LangSmith client (for OQ5)**: `langsmith` exposes `client.listRuns(...)` and
  the `datasets`/examples resources, so a "read results back from LangSmith"
  design is *technically feasible* — it is a product decision, not a missing
  capability.

## Decisions

1. **Persist a computed rollup, not raw LangSmith reads.**
   Add one collection, `evalruns` (working name, see OQ6), one document per
   suite run (a "run" = one execution of the whole suite, possibly across
   several models). Each doc stores: `startedAt`, `finishedAt`, `status`
   (`running|done|error`), `models[]`, and per-case results
   (`caseId, model, provider, score, report`). The admin tab reads Mongo, so a
   page load never hits LangSmith — consistent with the #179/#186 "stored so a
   deploy does not wipe it" rationale.

2. **The scheduled job runs the existing suite in-process, reusing
   `runCase`/`gradeRun`.** The current `scripts/run-evals.ts` mixes CLI
   parsing, fixture seeding, grading, and LangSmith export. Extract the
   **grading core** into a service (`src/server/services/evalRunService.ts`)
   that the CLI and the scheduler both call, so there is one code path (same
   stance as `runModelComparison` shared by CLI+admin for #129). The CLI keeps
   its flags/printing; the scheduled path calls the service and writes the
   rollup. **The service must not call `mongoose.connect`/`disconnect`** —
   in-process it must use the shared connection the server already owns, so the
   connect/disconnect moves up into `scripts/run-evals.ts` only.

3. **Schedule with the existing in-process poller idiom, gated to a daily
   window — no new dependency.** No cron library is present, and adding one
   for a single midnight job is unwarranted. A `setInterval` whose tick checks
   "has a run started for today's UTC date?" (or a configurable hour) is
   sufficient and matches `assetJobService`. The scheduler is started in
   `startServer()` behind `NODE_ENV !== 'test'` and is idempotent: if a run for
   the current window already exists, the tick is a no-op, so restarts do not
   double-run. Follow the poller's busy-guard so a long run does not stack
   ticks.

4. **LangSmith remains a best-effort exporter, not the source of truth for
   the tab.** The rollup is written from local grading results (which already
   exist before any LangSmith call). If the export fails, the run is still
   recorded — the admin tab must not depend on LangSmith availability. This
   mirrors `run-evals.ts`'s "keeping local grading" fallback. (The alternative
   — querying the `tova-evals` dataset — is OQ5.)

5. **Eval failures must never crash the server or the poller.** A run-level
   crash is recorded as `status: 'error'` with the message, exactly as the
   sweep mode already distinguishes run crashes (`error`) from graded fails.
   The poller wraps ticks in try/catch.

6. **Serialise runs — at most one eval run in flight.** The fixtures use one
   reserved user id and seeding/clearing is not concurrency-safe, and a
   daily run would otherwise overlap a "Run now". The service/orchestrator
   holds a single in-process guard (and consults `status: 'running'` in Mongo
   for cross-restart safety): a second request while one is running is rejected
   (manual `POST` returns 409) or no-ops (scheduler tick). This is a hard
   requirement, not a nicety — see OQ7 for the crash-recovery wrinkle.

7. **New endpoint(s): read-mostly, with an explicit manual trigger.**
   - `GET /api/admin/evals/runs` — recent runs, newest first, with per-run
     summary (counts of pass/partial/fail/error).
   - `GET /api/admin/evals/runs/:id` — one run's per-case breakdown.
   - `POST /api/admin/evals/run` — manual "run now" for the admin (reuses the
     same service). This is the operationally useful escape hatch and the
     simplest way to test the feature end-to-end without waiting for midnight.
     Admin-guarded like every other admin mutation.
   All shapes go in `src/shared/contracts.ts` (new `AdminEval*` names — see
   OQ6).

8. **New admin tab "Evals"** (client): recent-runs table (date, models,
   pass/partial/fail counts, status) and a drill-down for one run's case
   results. Read-only except the "Run now" button. Built like
   `AdminLangsmithView` (extracted component, loaded on tab activation) and
   registered in `src/client/src/components/AdminView.tsx` (state union,
   `sectionContent` array, conditional render).

9. **Configurable schedule, sensible default.** Add a config accessor for the
   eval schedule on `src/server/config/index.ts` (lazy getter, same style as
   every other accessor), with a default of disabled. **Do not invent a new
   `TOVA_EVALS_*` family without confirming it** — the runner already uses
   `TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER` (singular `EVAL`). Name consistency
   and the default on/off are OQ4. Code reads config through
   `src/server/config/index.ts`, never `process.env` ad hoc (issue #142).

## Detailed task breakdown

Each item is intended to be safely deliverable as a single commit. Concrete
steps and the exact files/hooks to touch are listed so the work is mechanical.

### T1 — Rollup model + migration

1. New `src/server/models/EvalRunRecord.ts` (name pending OQ6), Mongoose
   schema: `startedAt: Date` (indexed desc), `finishedAt: Date | null`,
   `status: 'running'|'done'|'error'` (indexed), `error: String | null`,
   `models: [String]`, and `results: [{ caseId, model, provider, score, report }]`.
   Add one module-level comment in the `ModelMetricStat` house style stating
   that this is a computed rollup, written by the eval service, read by the
   Evals tab.
2. Indexes: `{ startedAt: -1 }` for the list query; consider
   `{ status: 1, startedAt: -1 }` for the idempotency/catch-up check.
3. New `migrations/<timestamp>-create-eval-runs.ts` cloning the
   `create-error-logs` `listCollections` guard; creates the collection and the
   `startedAt` index; `down` drops the collection.
4. Unit test `EvalRunRecord.test.ts` following `AssetJob.ts`/`ModelMetricStat`
   test style (schema defaults, index presence).

### T2 — Extract the grading core into a service

1. New `src/server/services/evalRunService.ts`. Exports:
   - `runEvalSuite({ models, keepFixtures }, deps?)` → runs `seedEvalSource`,
     iterates `CASES × models` via `runCase` + `gradeRun`, best-effort pushes
     to LangSmith, and returns the per-case results array. **Deps injectable**
     (connectors/`runCase`/`gradeRun`/LangSmith client) so unit tests mock
     them without live providers.
   - `startEvalRun({ models, trigger })` → creates a `running` doc, awaits
     `runEvalSuite`, settles the doc to `done`/`error`. Owns the OQ7 lease.
   - `resolveModelsFlag`/`parseModelsFlag` moved from the script so CLI and
     scheduler share parsing.
   - The `resolveAssertions` `@repo:` reader currently in the script moves too
     (it reads repo files; keep the `repoRoot` derivation in the service, or
     inject the reader).
2. Move the `pushToLangSmith` helper into the service (exported for tests or
   kept private + tested through `runEvalSuite`). Keep the `DATASET_NAME` /
   `SCORES` constants there.
3. Refactor `scripts/run-evals.ts` to: keep `mongoose.connect`/`disconnect`,
   call the service, and keep the existing stdout printing (`printSweepTable`,
   per-case lines). The script's behaviour — including `--keep-fixtures` and
   `--models` — must be unchanged; if the service returns results rather than
   printing, the script prints them.
4. Service unit tests with `runCase`/connectors/LangSmith mocked: happy path
   writes one `done` doc; a thrown case is recorded as `error` in sweep mode;
   a thrown run writes `status: 'error'`; LangSmith failure still records the
   run.
5. Confirm the CLI still works: run a key-gated `--models` invocation against
   the local stack (or a dry subset) and compare stdout shape to `git stash` of
   the pre-refactor script.

### T3 — Scheduler

1. New `src/server/services/evalScheduler.ts` modelled on
   `assetJobService.ts`: `startEvalScheduler(runFn, opts)`,
   `stopEvalScheduler()`, `isEvalSchedulerRunning()`; internal `timer` +
   `busy` guard; `.unref?.()`. Injectable run function (defaults to
   `startEvalRun` from T2).
2. Tick logic: if the current UTC day already has a run (query the rollup by
   date window), no-op; else run. Catch-up-on-boot is OQ1 — implement it only
   if OQ1 resolves that way; otherwise the plain "is there a run today?"
   check.
3. Config accessor `config.evals.enabled` / `config.evals.hourUtc` (names per
   OQ4) in `src/server/config/index.ts`, lazy getters.
4. Start it in `startServer()` in the same `NODE_ENV !== 'test'` block as
   `startAssetJobPoller` (`src/server/index.ts:126–128`). Do **not** add a
   shutdown hook — none exists for the asset poller either (out of scope).
5. Scheduler unit tests with the run function injected and fake timers:
   enabled/disabled, once-per-window, busy-guard, error swallowed and recorded.

### T4 — Admin routes + contracts

1. New `src/server/routes/adminEvals.ts` with `adminGuard` cloned from
   `adminLangsmith.ts`: three routes from Decision 7. Validate `:id` against a
   hex ObjectId pattern before querying; map "not found" to 404; map a busy
   manual run to 409 (Decision 6); 503 if the feature/scheduler is
   unconfigured is **not** needed (the tab reads Mongo, always available).
2. New wire types appended to `src/shared/contracts.ts`
   (`AdminEvalRunSummary`, `AdminEvalRunsPayload`, `AdminEvalCaseResult`,
   `AdminEvalRunDetail`) — names pending OQ6.
3. Wire in `src/server/index.ts` under `/api/admin` next to
   `adminLangsmithRoutes`.
4. Route tests `adminEvals.test.ts` following `adminLangsmith.test.ts`: 401
   (no auth), 403 (non-admin), list ordering + limit clamp, detail 404 for a
   missing/garbage id, manual-run happy path (service mocked) → 202/200 + doc
   id, busy manual run → 409, service error → 5xx with a message.

### T5 — Client service + tab

1. Add `AdminEvalsService` (plain object, same style as `AdminLangsmithService`)
   to `src/client/src/services/admin.ts`: `listRuns`, `getRun`, `runNow`.
2. New `src/client/src/components/AdminEvalsView.tsx`, extracted like
   `AdminLangsmithView.tsx`: load on mount, `loading`/`error`/empty states,
   adjacent markup, `data-testid`s (`evals-runs`, `evals-run-<id>`,
   `evals-run-detail`, `evals-run-now`, `evals-error`). Mobile-first: table
   must not overflow without an affordance (AGENTS.md) — verify at 375px.
3. Register the tab in **`src/client/src/components/AdminView.tsx`**: extend
   the `activeSection` union (line 72) and `sectionContent` array (line 411),
   import the view, and add the conditional render beside line 1151.
4. Client tests `AdminEvalsView.test.tsx` (mock the service): list render,
   drill-down fetch, run-now click calls the service and refreshes, error/
   empty states.

### T6 — Verify

1. `npm run ci` must exit 0 (single gate; it runs client then server).
2. Playwright render of the Evals tab at phone width (~375px) **and** desktop:
   **use the `playwright-cli` skill**, not the default 1280×720 viewport.
3. One real manual "Run now" against the local stack (`npm run stack:up`,
   `npm run db:password`), confirming a `evalruns` doc is written (query via
   `scripts/mongo.ts`) and rendered as a row. Record the doc id and the
   rendered screenshot path here.
4. Record evidence below under "Verification".

### T7 — Docs

1. Add the new schedule vars to `.env.example`.
2. On merge, add a line to `docs/progress.md` (historical log, updated at
   ship — not now).

## Open questions

Unresolved. The task breakdown deliberately avoids depending on any of these
being answered a particular way, **except** where an item is explicitly marked
as blocked (OQ7). Each has a flagged fallback so implementation can proceed.

- **OQ1 (scheduling mechanism / missed windows).** In-process `setInterval` +
  daily-window guard (Decision 3) is coupled to server uptime: a redeploy or
  restart around midnight can miss the run, and the idempotency check then
  skips that day. Alternatives: an external cron/systemd timer invoking
  `npm run evals`; or a catch-up-on-boot check ("no run for the last completed
  window → run now"), which closes the gap without new infra. **Fallback:**
  implement the in-process poller **with** the catch-up-on-boot check. Confirm
  poller vs external cron.

- **OQ2 (which models to eval).** A daily run over *all* wired models
  (`--models all`) is expensive and slow: the suite drives live providers and
  the web_search case needs a Brave key. The ticket does not name a model set.
  Options: one fixed model, the current routing pool, or an env-configured
  list. **Fallback:** default to the runner's existing single-model default
  (`TOVA_EVAL_MODEL`, `openai/gpt-oss-20b`) with an override, and record the
  exact set in `models[]`.

- **OQ3 (retention / document growth).** One doc per day with ~10 cases × N
  models grows unbounded. Does the tab need retention (keep N days / cap
  docs)? **Fallback:** keep all docs; the list endpoint defaults to the last
  30 runs and accepts a limit; defer pruning.

- **OQ4 (env var names + default on/off).** The runner already uses
  `TOVA_EVAL_MODEL` / `TOVA_EVAL_PROVIDER` (singular). The plan's draft used
  `TOVA_EVALS_ENABLED` / `TOVA_EVALS_HOUR_UTC` (plural) — inconsistent. Which
  family, and is scheduling on by default? Running live provider calls daily
  from a fresh deploy may surprise (and cost). **Fallback:** singular
  `TOVA_EVAL_SCHEDULE=off|daily` + `TOVA_EVAL_HOUR_UTC` (default `off`);
  manual "Run now" works regardless. Confirm names + default.

- **OQ5 (LangSmith dataset query vs local rollup).** The ticket says "in
  theory this can be done in LangSmith and pulled to a calculated stored DB
  collection" — i.e. read results *back* from the `tova-evals` dataset and
  aggregate. Decision 4 instead writes local grading output and treats
  LangSmith as export-only. `langsmith` does expose `listRuns` + datasets, so
  the ticket's route is feasible; it is a design choice, not a blocked one.
  **Fallback:** proceed local-first; raise as a follow-up if the owner wants
  the tab to reflect the dataset (e.g. runs from any host roll up).

- **OQ6 (naming collisions).** `src/server/evals/types.ts` already exports
  `EvalRun` (the *observed* run) and `EvalResult` (grader output). Reusing
  either for the persisted rollup or its per-case rows would be confusing and
  may collide at import sites. Candidate names: model `EvalRunRecord`,
  collection `evalruns`, wire types `AdminEval*`. **Fallback:** use those
  names. Confirm no preference for lifting the rollup types into `types.ts`
  (which would force a rename of the existing ones).

- **OQ7 (crash recovery of a `running` row — decision-blocking).** If the
  server dies mid-run, a `status: 'running'` doc is stranded and (per Decision
  6) blocks all future runs, including the next day's. The asset poller solves
  the analogous problem with `requeueStaleAssetJobs` (a time-based requeue).
  We can mirror that (requeue/expire a `running` row older than N hours). This
  is flagged as blocking because Decision 6's serialisation makes "never
  recover the stranded lease" a correctness bug, not a nicety. **Fallback:**
  add a stale-lease sweep at scheduler start, mirroring the asset poller.
  Confirm the staleness threshold (e.g. 2× the observed suite duration).

### New questions raised by the critic pass

- **OQ8 (stale-lease reclaim timing).** `reclaimStaleEvalRuns` runs **only once at
  scheduler start**, not per tick. `STALE_EVAL_RUNNING_MS` is 2h. A run that
  strands inside a running process (e.g. `executeEvalRun` hangs on a provider
  after the finally-cleared lease) blocks the manual button for the process's
  whole life, and blocks the daily job until the next restart. Should the reclaim
  move into the tick (like `requeueStaleAssetJobs` is polled) and/or should a
  manual "Run now" offer a force-reclaim? Threshold (2h) still unconfirmed.
- **OQ9 (per-model view).** The list row shows aggregate counts across all
  models; the ticket asks for outcomes "per case and model, over time". The
  drill-down shows per-case rows with model, but there is no per-model rollup
  or trend in the tab. Is a per-model/trend view wanted in the first tab, or is
  the drill-down sufficient (as Decision 8 assumes)?
- **OQ10 (LangSmith example growth).** `pushToLangSmith` creates a fresh example
  per case per run, so the `tova-evals` dataset grows one example per case per
  run (≈10/day). The original CLI had the same behaviour, but now it runs daily
  unattended. Should re-runs reference existing examples instead of appending?
  (Pre-existing behaviour, inherited by the scheduled path.)

## Follow-ups (deferred)

- Retention/pruning of old `evalruns` documents (pending OQ3).
- A trend view (scores over time per case/model) — the rollup supports it;
  out of scope for the first tab.
- Generalising the LangSmith export to a per-model evidence base is #158's
  territory; not revisited here.
- External/cron scheduling if OQ1 resolves away from the in-process poller.
- Graceful server shutdown hooks (missing today for the asset poller too);
  not introduced here.

## Verification

To be completed during T6. Record: `npm run ci` result, Playwright phone +
desktop screenshots of the Evals tab, and the output of a real manual run
against the local stack (the written `evalruns` doc and its rendered row).

### T6 evidence (this pass)

- Targeted tests: `EvalRunRecord.test.ts` (4), `evalRunService.test.ts` (11),
  `evalScheduler.test.ts` (9), `adminEvals.test.ts` (7),
  `AdminEvalsView.test.tsx` (6) — all green. `npm run typecheck` green.
  Full `npm run ci` and the Playwright/phone render are deferred to the next
  iteration (need the local stack and a real run).

### Critic pass (this pass) — evidence and fixes

Defects found and fixed:

1. **Wrong collection (correctness).** `EvalRunRecord` had no explicit
   collection, so Mongoose pluralised it to `evalrunrecords` while the migration
   `20261007000000-create-eval-runs` pre-creates `evalruns`. The migration was
   dead and the intended indexes sat on an unused collection; a real "Run now"
   wrote to `evalrunrecords`. Fixed with an explicit `{ collection: 'evalruns' }`
   on `mongoose.model`, plus a model test pinning `EvalRunRecord.collection.name`.
2. **Scheduled/manual runs never reached LangSmith (missed requirement).** Only
   `scripts/run-evals.ts` resolved a client; `executeEvalRun`/`startEvalRun` called
   `runEvalSuite` with no `langsmithClient`, so neither the daily job nor the
   admin "Run now" exported to the `tova-evals` dataset — the ticket's
   "in LangSmith" intent. Fixed by resolving `langsmithClientFromEnv(config.langsmith.apiKey)`
   at the two composition roots (the `POST /api/admin/evals/run` route and the
   scheduler closure in `startServer()`), forwarded into `executeEvalRun`.
3. **#142 drift.** The route and `startServer()` read `process.env.TOVA_EVAL_MODEL`/
   `TOVA_EVAL_PROVIDER` directly. Added `config.evals.model`/`config.evals.provider`
   accessors and switched both call sites to config.
4. **Defensive hardening.** `countScores` used `result.score in counts`, which
   walks the prototype chain (a corrupt score `"constructor"` would match);
   switched to `Object.hasOwn`, with a regression test.

Verification performed this pass:

- `npx tsc --noEmit` green; `npm run lint` and `npm run format` green.
- **`npm run ci` exits 0** (client lint/format/test/build, then server
  lint/format/typecheck/test): 81 server suites / 1102 tests, 18 client suites /
  230 tests, all green.
- New/updated tests green: `evalRunsAdminService.test.ts` (6, new),
  `evalRunService.test.ts` (+4), `adminEvals.test.ts` (+1),
  `config/index.test.ts` (+2), `EvalRunRecord.test.ts` (+1),
  `AdminEvalsView.test.tsx` (6).
- Playwright render at **375×667** (mobile context) of the live admin Evals tab:
  empty state, a populated run row (`1p 1~ 1f done`) with no horizontal overflow
  (`documentElement.scrollWidth === 375`), and the per-case drill-down. Screenshots
  at `/tmp/opencode/evals-empty.png`, `/tmp/opencode/evals-row.png`,
  `/tmp/opencode/evals-detail.png`.
- **Real manual "Run now"** against the local stack: created rollup
  `_id 6ac65adbedf491e4d8e484a1`, `status: done`, `startedAt 14:44:43.051Z`,
  `finishedAt 14:46:07.872Z` (~84s), 10 graded case results, rendered as a row.

Pre-existing, **out of scope**: `src/server/services/modelConfigService.test.ts`
("rules out models flagged tools:false from the completions pool") **flakes** —
it failed in one full `npm test` run and passed in another (`npm run ci` above),
while passing in isolation. It also failed identically on `origin/main` in a
detached worktree, so it is an order/isolation flake unrelated to #225 (the
branch does not touch that file or model logic). Per the cleanup-scope policy
this is raised, not fixed here.

## Done

- [x] T1 `EvalRunRecord` model + `20261007000000-create-eval-runs` migration + test.
- [x] T2 grading core extracted to `evalRunService`; `scripts/run-evals.ts` keeps
      connect/disconnect and stdout printing.
- [x] T3 `evalScheduler` (in-process poller, idempotent per UTC day, stale-lease
      reclaim, busy guard) + `config.evals` + started in `startServer()`.
- [x] T4 `adminEvals` routes + `AdminEval*` shared contracts + tests.
- [x] T5 `AdminEvalsService` + `AdminEvalsView` + Evals tab registration + tests.
- [x] T6 full `npm run ci` (exit 0) + Playwright mobile render + real manual run
      evidence (rollup `6ac65adbedf491e4d8e484a1`, done, 10 cases) — see
      "Critic pass (this pass)".
- [x] T7 `.env.example` schedule vars; plan archived to `docs/` on merge.

## Resolved open questions (fallbacks taken)

- **OQ1** — in-process `setInterval` poller **with** the catch-up-on-boot
  check (a tick is a no-op unless the UTC day has no run and the start hour has
  passed). Poller vs external cron still open for the owner.
- **OQ2** — default single model (`TOVA_EVAL_MODEL`, `openai/gpt-oss-20b`) with
  `TOVA_EVAL_MODELS` csv override; the exact set is recorded in `models[]`.
- **OQ3** — keep all docs; list defaults to the last 30, `limit` clamped to 100.
  Pruning deferred.
- **OQ4** — singular `TOVA_EVAL_SCHEDULE=off|daily` + `TOVA_EVAL_HOUR_UTC`,
  default **off**. Names still open for the owner.
- **OQ5** — local-first rollup; LangSmith stays export-only.
- **OQ6** — model `EvalRunRecord`, collection `evalruns`, wire `AdminEval*`;
  existing `evals/types.ts` `EvalRun`/`EvalResult` untouched.
- **OQ7** — stale-lease sweep at scheduler start (`reclaimStaleEvalRuns`,
  threshold `STALE_EVAL_RUNNING_MS` = 2h), mirroring `requeueStaleAssetJobs`.
  Threshold still open for the owner.
