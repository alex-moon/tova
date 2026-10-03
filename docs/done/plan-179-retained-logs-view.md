# Plan — #179 retained logs in the admin view

## Motivation

Server logs were only available from an in-memory ring buffer (`logService.ts`,
cap 1000) that is wiped on every deploy/restart — the exact failure that
spawned #179. The ingest half is now live: Grafana Alloy ships container
stdout to **Grafana Cloud (hosted Loki)**, verified end-to-end (7962 entries
received; read+write token confirmed).

This change completes #179's read half: the admin Logs view reads **retained
logs from Loki** (default last 24h) instead of the in-memory buffer, and the
buffer is removed. Per owner decision, the retained view **replaces** the live
tail (no toggle).

GitHub: https://github.com/alex-moon/tova/issues/179

## Decisions

1. **Retained Loki view replaces the live tail.** Owner decision 2026-10-03.
   No dual code path, no toggle.

2. **Repurpose `GET /api/admin/logs`** rather than add a second endpoint. The
   path, admin guard, and client call site stay; only the data source changes.
   `/api/admin/logs` now returns one time-window page of retained logs
   (no cursor/polling — a window query is not incremental).

3. **Kill the ring buffer, keep the logging function.** `logService` does three
   jobs; only the buffer is redundant:
   - **Delete:** `buffer`, `nextId`, `CAP`, `LogEntry` (buffer shape),
     `pushLog`, `getLogs`, `clearLogs`, `GetLogsParams`, and the
     `GET /api/admin/logs` buffer route/tests.
   - **Keep (slimmed):** `attachConsoleCapture` / `detachConsoleCapture` — still
     intercept `console.*`, but only to persist `error`-level lines to Mongo
     (`ErrorLog`). No array.
   - **Keep, unrelated to Loki:** `ErrorLog` persistence (#175). Deleting the
     module outright would break it, which is why the carve-out exists.
   - `logger` stays (used by `requestLog`); it now writes console + persists
     errors, with no buffer.

4. **New service `src/server/services/lokiLogs.ts`.** Queries Loki's
   `query_range`:
   - Base URL = `LOKI_URL` with the `/loki/api/v1/push` suffix stripped
     (the env value is the full push URL — discovered during smoke test).
   - Basic auth: `LOKI_USERNAME` / `LOKI_PASSWORD`.
   - `direction=backward`, `limit` default 200 (server cap 500).
   - Window: default 24h, server cap 168h (7d).
   - Normalizes Loki streams → `AdminRetainedLogEntry`.
   - **Graceful degradation:** when Loki is unconfigured or unreachable, return
     an empty list plus a `configured: false` / message rather than a 500.

5. **Filtering.** Level + text filters are applied **server-side after fetch**,
   not in LogQL. Rationale: container stdout does not carry our structured
   severity; `detected_level` is Grafana's cosmetic guess. Reliable filtering
   needs post-processing. (Confirmed during implementation against Alloy's
   emitted labels.)

6. **Default window 24h** chosen by owner ("last 24 hours is fine").

## Done

- [x] Plan doc (this file).
- [x] `lokiLogs` service with graceful degradation + unit tests.
- [x] Repurpose `GET /api/admin/logs` to the retained source; update route tests.
- [x] Shared contracts for the retained entry/payload.
- [x] Slim `logService` (drop buffer, keep capture + error persistence); update
      its tests.
- [x] Client: `AdminLogsService` + `AdminView` logs tab read the retained shape.
- [x] Verify with `npm run ci` (lint, format, typecheck, tests, build).
- [x] Live check: query the local server against Grafana Cloud and confirm the
      admin endpoint returns recent lines.

## Follow-ups (deliberately deferred, per #179 comment)

- Pagination / cursoring beyond the latest N.
- Longer retention (90d) and Loki backup/archival.
- Bundled text-export dump script (writes the same queries to
  `data/log-dumps/`).
- Least-privilege split of the Loki token if desired later.
