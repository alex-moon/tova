# Plan — Issue #50: Coarse user geolocation (country-level) via country.is with ip-api.com fallback

Branch: `feat/50-coarse-user`

## Motivation

The server knows nothing about where a user is, so locale/timezone/weather/"near me"
questions go unanswered. Issue #50 asks for *coarse*, country-level geolocation only,
resolved from the request IP on authenticated requests, cached on the user document,
and surfaced both in the chat system context and `GET /api/auth/me`. Explicit
non-goals: city/postal precision, geofencing, consent UI beyond a "remove my location"
affordance (follow-up), and any frontend use beyond display.

## Decisions so far

- Providers: primary `https://api.country.is/` (returns `{ip, country}`); fallback
  `http://ip-api.com/json/` (`country`, `countryCode` only — ignore all other fields).
- Only `country` + `countryCode` persist; nothing city/lat/lon/ISP-shaped is kept.
- Resolve at most once per user per 7 days unless missing.
- Local/private IPs skip resolution entirely (dev/CI safe).
- Both providers failing is silent and non-blocking: chat proceeds without location.

## Existing-code anchors

- User model: `src/server/models/User.ts` — inline subdocument pattern for `settings`;
  `location` will follow the same shape.
- Wire shape: `toAuthUser` in `src/server/services/userService.ts:7` feeds both
  `GET /api/auth/me` (routes/auth.ts:244) and `PATCH /api/profile` responses.
- System context: `buildSystemContent` in `src/server/services/promptAssembly.ts:81`
  already assembles profile blocks with namespace-tagged envelopes
  (`buildUserEnvelope`); a `user:location` block slots in there.
- Middleware: `authenticate` (`src/server/middleware/auth.ts`) provides
  `req.user.id`; Express `req.ip` respects `trust proxy` once configured.

## Task checklist (each ~one commit)

1. **Model + UserService**: add `location` subdocument to `User.ts`
   (`country: String, countryCode: String, resolvedAt: Date, default: null`,
   `{ _id: false }`); extend `UserDocument`; extend `toAuthUser` to include
   `location: { country, countryCode }` when present. Extend
   `src/shared/contracts.ts` `AuthUser` accordingly. Update profile/auth contract tests.
2. **Geo location service** `src/server/services/geoLocationService.ts`:
   - `isPrivateIp(ip)`: skip `::1`, `127/8`, `10/8`, `172.16/12`, `192.168/16`,
     `169.254/16`, IPv6 ULA/fc00::/7, missing IP.
   - `resolveCountry(ip)`: fetch country.is (2s timeout) → country.is fails or
     rejects → fetch ip-api.com with `fields=country,countryCode` (2s timeout);
     validate shape; swallow all errors, return `null`.
   - `ensureUserLocation(userId, ip)`: read user; if `location.resolvedAt` newer
     than 7 days **or** location exists and not stale, return cache without network.
     Otherwise resolve and `User.updateOne({ _id }, { $set: { location } })`; on
     resolve failure, still persist `location.resolvedAt`? — *No*: leave null and
     short-circuit retries with an in-process per-user cooldown so we don't
     re-query every request (see Open question 2). Use global `fetch`
     (Node ≥18, already the repo standard elsewhere) — inject via parameter or
     module handle for test mocks (match `webSearchService` mocking style).
3. **Wire-up in auth-middleware-adjacent path**: call `ensureUserLocation` on
   `GET /api/auth/me` and on chat routes (`POST /api/chat`, `/api/chat/stream`)
   — fire-and-forget on chat, awaited on `/me` with `req.ip`. Set
   `app.set('trust proxy', ...)`: check deployment env (`docker-compose*.yml`,
   any nginx notes) and configure conservatively, then document which header is
   authoritative (`X-Forwarded-For`, first hop) in the plan/PR so deploy config
   forwards it. Guard: wrap in try/catch so resolution can never fail a request.
4. **Chat context injection**: extend `buildSystemContent` user pick to include
   `location`; emit `user:location` envelope with a short factual line
   ("User is in Finland (FI)") only when country is set, within the existing
   `[CONTEXT_INTRO ... RELEVANCE_RULE]` block. Update `promptAssembly.test.ts`.
5. **Tests**: unit tests for provider selection, fallback, private-IP skip,
   cache/staleness, cooldown, and envelope injection with mocked fetch;
   integration-lite test that `/api/auth/me` renders `location` and chat degrades
   gracefully when providers fail. No live API calls in CI (mock `global.fetch`).
6. **Lint/format/typecheck + full `npm run ci`; update plan doc; PR.**

"Remove my location" (settings affordance) and frontend display are deliberately
deferred to follow-ups per the ticket's out-of-scope list, except that
`GET /api/auth/me` already exposes the data.

## Open questions

1. **Proxy trust config value.** Whether deployments run behind a reverse proxy
   and what `trust proxy` value is correct (1 hop? loopback?). Plan: default to
   `trust proxy` configured as `1` with a note; confirm from docker-compose before
   implementing. If ambiguous, choose loopback-only trust and document.
2. **Retry-after-failure policy.** Ticket says resolve once per 7 days *unless
   missing*; but never retrying a failed resolution means transient failures are
   permanent for that user. Proposed: on failure record nothing on Mongo but keep
   a short in-process retry cooldown (e.g. 1 hour per user) — needs a decision at
   implementation time.
3. **Where to hook the resolve call.** `/me` + the two chat routes are the obvious
   spots; a single middleware could cover them, but chat routes stream and the
   resolve must never add latency there — leaning fire-and-forget on chat vs
   awaited on `/me`. Fine either way; pick when wiring.
4. **ip-api.com is plain HTTP only (free tier).** Acceptable for coarse country
   data (no secrets sent), but worth noting in the PR; using `https` requires a
   paid key.

{}

