# Plan #213 — Endpoint overload (`engine_overloaded`) must fail over

## Motivation

A routed model whose endpoint is temporarily saturated fails the turn hard with a
raw provider error. Observed on DeepInfra `deepseek-ai/DeepSeek-V3.2`:

```
statusCode: 429
responseBody: {"error":{"message":"Model busy, retry later","code":"engine_overloaded"}}
```

`isRateLimitError` classifies on `statusCode === 429` alone
(`src/server/services/modelFailover.ts:40`), so this per-endpoint overload is
mistaken for an account rate limit and both failover loops bail loudly. The
fix must distinguish two different 429s:

| Signal | Meaning | Response |
|---|---|---|
| `engine_overloaded` / "Model busy" / "overloaded" | endpoint saturated | short cool-off + re-route now |
| `rate_limit_exceeded` / TPM / RPM / "too many requests" | account throttled | fail loudly (back-off deferred) |

Ticket: https://github.com/alex-moon/tova/issues/213

## Decisions

- **Discriminate on the provider body `code` and a narrow message set, not
  `statusCode`.** Overload detection runs *before* the rate-limit check so an
  overload-shaped 429 no longer matches `isRateLimitError`.
- **Overload gets its own short, env-tunable cool-off TTL** (`MODEL_OVERLOAD_COOL_OFF_MINUTES`,
  default 5), distinct from the 6h `MODEL_COOL_OFF_HOURS`. Saturation clears in
  seconds-to-minutes; a 6h disable would take a healthy model out for the day.
  `disableModel` gains an optional TTL argument; existing callers are unchanged.
- **Keep the existing `MAX_ATTEMPTS = 8` cap.** A distinct overload cap is
  speculative; eight disable-and-re-route rounds already bound any sane pool.
- **Genuine account 429s keep their current behaviour** (fail loudly, no
  disable, no retry). The deferred back-off mechanism stays out of scope.
- **Tally agrees with failover.** `modelErrorTally.categorize` currently maps
  `status === 429` to `rate_limit`; it must classify an overload-shaped 429 as
  `overloaded` so the admin error view matches routing behaviour.
- **Cover both loops.** `withModelFailover` (service) and the inline stream loop
  in `routes/chat.ts` duplicate the rate-limit gate; both must treat overload as
  retry-worthy.

## Done

- [x] `isOverloadError(err)` in `modelFailover.ts` (body `code`, `data.error.code`,
      message regex), exported and tested.
- [x] `disableModel(provider, model, ttlMs?)` + `overloadCoolOffMinutes()` in
      `modelConfigService.ts`.
- [x] `withModelFailover` re-routes on overload with the short TTL.
- [x] Inline stream loop in `routes/chat.ts` re-routes on overload.
- [x] `modelErrorTally.categorize` → `overloaded` for overload-shaped 429.
- [x] Tests pin overload → re-route; true rate limit → unchanged.
- [x] `npm run ci` green.

## Follow-ups

- Genuine account 429 back-off/retry (separate mechanism, still deferred).
- Evidence gathering across providers (Groq overload signal) if a provider
  other than DeepInfra exhibits a different body shape — message regex is the
  fallback until then.

## Note on the gate

`npm run ci` intermittently failed (~50%) on a pre-existing flaky timeout in
`src/server/routes/profile.purge.test.ts` (the factory-reset test seeds two
workspaces and exceeded the 5s default under parallel load; it passes in
isolation and with `--runInBand`, and reproduces on `main`). Confirmed
unrelated to this change and fixed in-scope with a 15s per-test timeout.
