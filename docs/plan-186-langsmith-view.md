# Plan — #186 Admin view for LangSmith

## Motivation

Routing decisions are evidence-first (AGENTS.md): traces from the `tova-dev`
LangSmith project are the primary evidence for tier/guard questions (#129 was
diagnosed entirely from a trace showing the guard returning empty replies).
Today reading one means leaving the app and navigating smith.langchain.com.
This ticket adds the two tools the owner needs most, both read-only, as a new
admin tab:

1. **Traces browser** — recent root runs with status/model/latency/tokens,
   errors-only and model filters, and a drill-down showing the run tree with
   inputs, outputs and errors.
2. **Model stats** — a last-7-days per-model rollup (runs, errors, avg
   duration, tokens) as a routing-health glance.

GitHub issue: alex-moon/tova#186.

## Verified API facts (live, 2026-09-27)

- `POST /api/v1/runs/query` returns `{ runs, cursors, ... }` — NOT an array
  (the array-cast bug in `tracePurge.ts` is #187, out of scope here).
- Working filters: `eq(is_root, true)`, `eq(status, "error")`,
  `eq(trace_id, ...)`, `gte(start_time, "<iso>")`; `select` trims payloads;
  default order is newest-first.
- Root runs are `agent run: 'tova-<provider>'`; the model name rides only on
  the `llm: '<model>'` child run. Chat turns are traced with no session
  metadata today (#187 note), so rows infer the model via a second llm-children
  query per page.
- `GET /api/v1/runs/:id` exposes `app_path` (deep link into the LangSmith UI).
- The API occasionally 503s transiently — read paths retry once on 429/5xx.

## Decisions

- **Read-only scope.** No feedback, datasets, or deletes here; the purge path
  stays in `tracePurge.ts` (and is #187's to fix).
- **New route file `adminLangsmith.ts`** (mirrors the `adminPats.ts` precedent:
  admin.ts stays focused), mounted at `/api/admin` with the same
  `authenticateBearerOrSession + requireRole('admin')` guard, so PAT auth
  works for the CLI path.
- **Service `langsmithTracesService.ts`** next to `tracePurge.ts`, same
  fetch/x-api-key patterns and name-match-only project lookup
  (never fall back to "first session returned"). Unconfigured key/project
  → 503 with a clear message (dev/stub parity stance of the codebase).
- **Model inference, not metadata**: rows list root runs, then one llm-child
  query per page (`and(in(trace_id, [...]), eq(run_type, "llm"))`) supplies
  each row's model. Model filtering happens post-merge (the model lives in a
  child run name — server-side filter strings would need fragile quoting).
- **Errors-only filter is server-side** (`eq(status, "error")` — verified).
- **Retry policy (added during implementation)**: the live API 429s burstily
  (the first stats smoke test failed on one) — 429 gets a 3-retry backoff
  budget (1s/2s/4s, honoring a longer `Retry-After`), transient 5xx one retry
  after 500ms; real 4xx propagates immediately.
- **Token counts come from the llm children**, not the root runs: root
  `total_tokens` was observed as 0 when querying with `select` (select is a
  hint — fields still come back — but aggregates read inconsistently), while
  child tokens are stable in both shapes. The children sweep (also used for
  the model join) pages to `JOIN_MAX_PAGES = 10` against tool-heavy traces.
- **Trace detail tree drops `chunk:` runs** — they are per-streamed-chunk
  artifacts (dozens per turn, 0-duration) that only add noise; agent/step/
  inference/llm/tool runs carry the diagnostic story.
- **List window, not pagination**: recent 50 root runs (fixed, newest-first).
  "Load more" deferred; recency + filters + drill-down is the job.
- **Stats: llm-run sweep, not root-join** (changed during implementation): the
  first root-based design (page roots, join llm children per page) made
  ~11–55 API calls against a burstily rate-limited API — the first live
  smoke test hung past 2 minutes. One paged sweep of `run_type = llm` runs
  since the window start answers per-model health in a handful of calls.
  Semantics kept honest in the contract: rows count llm *calls* (a tool turn
  makes several to the same model); turns that failed before any llm call
  are the traces list's job, not stats'.
- **Per-attempt request timeout** (`AbortSignal.timeout`, 20s): a stalled
  upstream connection must never hang an admin request.
- **Paged queries everywhere** (added during implementation): the live API
  rejects any per-query `limit` above 100 (verified: 101 → 400), so the
  trace detail pages by 100 up to `DETAIL_MAX_RUNS = 200`; a route test
  asserts every outgoing query body stays within the cap.
- **New tab UI lives in its own component** (`AdminLangsmithView.tsx`) instead
  of growing the already-1168-line `AdminView.tsx`; the tab bar gains
  `traces`. No refactor of existing tabs.
- **Content policy**: inputs/outputs are shown in the detail view — the admin
  route is the same trust audience as the LangSmith UI itself, and reading
  prompts is the point of the tool. (The logs-view redaction boundary in
  `logRedaction.ts` is about log output, not this.)

## Done

- [x] Ticket #186 filed (plus follow-ups #187 tracePurge shape bug, #188
      local e2e drift)
- [x] Branch `feat/tv/186-langsmith-view` from `origin/main`
- [x] Shared contracts: `AdminTraceRow`, `AdminTracesPayload`,
      `AdminTraceRun`, `AdminTraceDetail`, `AdminLangsmithModelStats`,
      `AdminLangsmithStatsPayload`
- [x] `langsmithTracesService.ts`: project resolve, listTraces (+model
      join), getTrace (tree, chunk runs dropped), stats aggregate; 429/5xx
      retry policy
- [x] `adminLangsmith.ts` routes: GET `/langsmith/traces`,
      GET `/langsmith/traces/:traceId`, GET `/langsmith/stats`
- [x] Mount in `server/index.ts`; server tests (guards, unconfigured 503,
      mapping/aggregation, retry budget)
- [x] Client: types re-export, `AdminLangsmithService`, `AdminLangsmithView`
      component (list, filters, detail drill-down, stats strip),
      data-testids, `AdminView` tab wiring
- [x] Client tests (`AdminLangsmithView.test.tsx`)
- [x] `.env.example` + AGENTS.md note: `TOVA_PAT` (live droplet) vs
      `TOVA_PAT_LOCAL` (local dev) PAT conventions
- [x] Local PAT smoke test against real LangSmith (owner minted a local PAT
      as `TOVA_PAT_LOCAL` in `.env`)
- [ ] `npm run ci` green
- [ ] PR opened

## Follow-ups

- #187 `tracePurge.ts` runs/query array-cast bug (silent no-op purge).
- #188 local e2e `ADMIN_PASSWORD` drift.
- Session metadata on chat turns (decide: wire `TraceContext` on the chat
  route or retire the purge premise) — folded into #187's note.
- "Load more" pagination and free-text trace search, if the fixed window
  proves limiting.
- Branch note: local `main` holds an unpushed housekeeping commit
  (`.gitignore /.env.swp`, 7a0ccb6) — owner to push or drop; this branch is
  based on `origin/main` to keep the PR clean of it.
