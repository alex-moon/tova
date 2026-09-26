# Plan #175 — error log persistence

## Motivation

[#175](https://github.com/alex-moon/tova/issues/175): the admin Logs view reads a
1000-entry in-memory ring buffer (`logService.ts`, issue #76). Server errors are
not persisted, so diagnostics depend on a live process and a restart loses every
logged error.

## Decisions

- **Persist at the choke point.** `pushLog` in `logService.ts` is the single
  write path for every log entry (direct `logger.*` calls plus the console
  capture). Persisting there covers all ~50 `console.error` call sites without
  touching any of them.
- **Errors only.** `info`/`warn` stay buffer-only — a 500/15-min request log
  stream would drown an error tally in Mongo writes.
- **Fire-and-forget writes, failures swallowed silently.** A persistence
  failure must never recurse back through the console capture (which would
  persist again → infinite loop), so the `.catch` is pure-swallow and skipped
  entirely in `NODE_ENV=test`.
- **Existing buffer contract unchanged.** The admin `/api/admin/logs` endpoint
  keeps reading the buffer. No retrieval endpoint yet — dump is queried via
  `scripts/mongo.ts` for diagnostics; retrieval can be a follow-up if wanted.

## Done

- [x] `src/server/models/ErrorLog.ts` — `ErrorLog` model (bufferId, ts, msg + timestamps)
- [x] `pushLog` persists `error`-level entries into `errorlogs`; mocked-model unit test
- [x] Migration `20260926000000-create-error-logs.ts` — collection + `createdAt` index
- [x] Follow-on (same ticket): `ModelRouteError` model, `modelErrorTally.ts`
      (`statusOf` / `categorize` / `recordModelError`), hooked into
      `inferenceService` as the single LLM entry point; unit tests
- [x] Migration `20260926000100-create-model-route-errors.ts` — collection +
      unique `(provider, model, status, category)` index
- [x] Live smoke against local Mongo (smoke then cleaned up): persisted log
      entries land; tally rows show `unknown_provider`, real DeepInfra 400 →
      `context_length`, synthetic 403 "api key is expired" →
      `invalid_or_expired_key`
- [x] `npm run ci` green (882/882)

## Tally categories

`missing_key`, `invalid_or_expired_key`, `forbidden`, `not_found`, `rate_limit`,
`context_length`, `overloaded` (503), `server_error` (5xx), `bad_request` (400),
`timeout` (abort/deadline text), `network` (conn-reset/socket/getaddrinfo text),
`unknown_provider`, `unknown`. Fail-closed: ambiguous text never invents a
confident story (bare 403 stays `forbidden`, not "key expired").

## Follow-ups

- Admin view for `modelrouteerrors` (read-only table next to Logs) — repo'ed
  under #175's broader diagnostics thread if wanted.
- Streaming error chunks (rethrown from `toNeutralStream`) surface the model
  message only, not an HTTP status — their tally rows will carry `status: null`
  until a route decides to parse upstream bodies.
