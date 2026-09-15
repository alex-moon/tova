# Plan — Issue #50: Coarse user geolocation (country-level) via country.is with ip-api.com fallback

Branch: `feat/50-coarse-user`

## Motivation

The server knows nothing about where a user is, so locale/timezone/weather/"near me"
questions go unanswered. Issue #50 asks for _coarse_, country-level geolocation only,
resolved from the request IP on authenticated requests, cached on the user document,
and surfaced both in the chat system context and `GET /api/auth/me`. Explicit
non-goals: city/postal precision, geofencing, consent UI beyond a "remove my location"
affordance (follow-up), and any frontend use beyond display.

## Decisions made (settled, from ticket + repo inspection)

- Providers: primary `https://api.country.is/` (returns `{ip, country}`); fallback
  `http://ip-api.com/json/?fields=country,countryCode` (free tier is HTTP-only —
  noted in the ticket; irrelevant to secrecy since the payload contains no secrets,
  but worth a PR note). Only `country`/`countryCode` are kept; every other field is
  dropped at parse time, never persisted.
- Resolution cadence: at most once per user per 7 days (stale check on
  `location.resolvedAt`); failed lookups do NOT touch Mongo — they retry only after
  an in-process cooldown (see Open question 2; the cooldown constant ships with a
  1-hour default and the code is correct under any value).
- Local/private IPs skip resolution entirely (dev/CI safe). List:
  `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, empty/unparsable IP.
- Both providers failing is silent and non-blocking: chat proceeds without location.
- No live API calls in CI: `webSearchService.test.ts` already establishes the
  convention of stubbing `global.fetch` with `jest.fn()` and restoring it in
  `afterEach` — geo tests copy that style, no dependency injection needed.
- "Remove my location" and frontend display are out of scope per the ticket; only
  exposing via `GET /api/auth/me` is in.

## Existing-code anchors (verified)

- User model: `src/server/models/User.ts` — inline subdocument pattern for `settings`;
  `location` follows the same shape.
- Wire shape: `toAuthUser` (`src/server/services/userService.ts:7`) feeds
  `GET /api/auth/me` and `PATCH /api/profile` responses; shared contracts in
  `src/shared/contracts.ts`.
- System context: `profileContextBlock` in `src/server/services/promptAssembly.ts`
  builds namespace-tagged envelopes (`buildUserEnvelope`); note its `Pick<UserDocument,
...>` signature must grow `location` too. `buildSystemContent` composes the blocks.
- Middleware: `authenticate` (`src/server/middleware/auth.ts`) provides `req.user.id`.
- Proxy topology (verified from `src/client/nginx.conf` and deploy history):
  user → host nginx (`/opt/ajmoon/nginx/ajmoon.conf`, outside the repo) →
  `src/client` nginx container → backend:5000; nginx already sets `X-Real-IP` and
  `X-Forwarded-For`. `trust proxy` is currently unset in the backend, so `req.ip` in
  production is the client-nginx container IP (private) — unusable for geo today.

## Task checklist (each ~one commit)

1. **Model + contracts + wire shape**
   - `User.ts`: add inline `location` subdocument `{ _id: false }` with
     `country: String, countryCode: String, resolvedAt: Date`; no default (absent =
     unresolved). Fields are optional; only these three ever exist.
   - `toAuthUser`: append `location: { country, countryCode }` when present
     (never expose `resolvedAt` over the wire unless a need shows up — leave it off;
     expose it in the follow-up "remove location" work if needed).
   - `src/shared/contracts.ts`: extend `AuthUser` with the optional location object.
   - Extend `src/server/routes/auth.test.ts` (me/profile contract tests) for the new
     shape; a user without location keeps the exact old wire shape (no empty object).
2. **Geo location service** `src/server/services/geoLocationService.ts`
   - `isPrivateIp(ip: string): boolean` — per the list under Decisions; empty string
     / malformed → `true` (skip).
   - `resolveCountry(ip): Promise<{ country: string; countryCode: string } | null>`
     - fetch country.is with `AbortSignal.timeout(2000)`; expect `{ ip, country }`
       with `country` a 2-letter code (validate `/^[A-Z]{2}$/`); invalid shape →
       treat as failure.
     - failure/timeout/shape-bad → fetch ip-api
       `http://ip-api.com/json/?fields=country,countryCode` with 2s timeout;
       validate the same way; stringify the result through the same narrow type.
     - all failures (rejection, non-ok status, bad shape) → return `null`; never throw.
   - `ensureUserLocation(user: UserDocument, ip: string): Promise<void>` — read the
     user's `location`: fresh (resolvedAt within 7d) → return; present-but-stale →
     resolve; absent → resolve unless inside the in-process failure cooldown.
     - In-process `Map<userId, resolvedAtTimestamp>` cooldown map (1h default) so a
       failed lookup is not retried on every request. Map never stores success —
       success is Mongo's job. Write-only growth of one entry per user is fine at
       this scale; note it.
     - Persist via `User.updateOne({ _id }, { $set: { location: { country,
countryCode, resolvedAt } } })` — `$set` only, never writes city-like data;
       countryCode persisted verbatim from the provider (uppercase-normalized).
   - Export the fetch handle resolution through `global.fetch` only; tests stub it.
3. **Wire-up: IP acquisition + trust proxy + call sites**
   - Central `getClientIp(req)` helper: use `req.ip` (Express honors `trust proxy`),
     do NOT hand-parse `X-Forwarded-For` ourselves (string list, ambiguous);
     `X-Real-IP` is not read because under the two-hop chain it currently points at
     the host nginx, not the real client — if Open question 1 resolves otherwise,
     only this helper changes.
   - `app.set('trust proxy', <hops>)`: set via a single server-side constant sourced
     from an env var (`TRUST_PROXY_HOPS`, default `1`) so the exact value is a deploy
     decision, not a code fork. Document in the PR: requests carry `X-Forwarded-For`;
     the compose nginx forwards it, the host nginx (outside this repo) appends the
     real client as the leftmost non-trusted entry when hops is configured right.
     Whatever Open question 1 decides, the code does not change — only the env value.
   - Call `ensureUserLocation(requestingUser, req.ip)` behind a try/catch:
     - awaited in `GET /api/auth/me` (cheap when cached, correctness matters more).
     - fire-and-forget (void, catch → no-op log) in the chat route(s) so it can never
       add latency. Find the exact chat handler(s) (`POST /api/chat`,
       `/api/chat/stream`) at implementation time and note which in the PR.
   - A shared middleware is rejected: chat streams and `/me` wants different
     await/detach semantics; the one-line call at each site is the honest version.
   - Respect the `plan-32` decision record: this ticket ORM is the first reason to
     set `trust proxy` at all; do it deliberately, not blindly, and restate the
     spoofing tradeoff in the PR (see open question 1).
4. **Chat context injection**
   - `profileContextBlock`: add `location` to the Pick; when `user.location?.country`
     exists, emit `buildUserEnvelope({ tagName: 'user:location', intro: ...,
content: 'User is in <Country> (<CC>)' })`. Intro wording: instruct the model
     that this is coarse, may be stale, and to use it only for locale-flavored
     answers ("near me", weather, currency).
   - No envelope line at all when location is absent — no "location unknown" noise.
   - Update `promptAssembly.test.ts`.
5. **Tests** (all mocked fetch, zero live calls in CI)
   - provider selection: country.is success short-circuits; country.is failure →
     ip-api used; both fail → `null`, no Mongo write.
   - shape validation: bad/missing/3-letter country → failure path.
   - `isPrivateIp`: each listed range + IPv6 + empty string.
   - cache: fresh resolvedAt → no fetch; stale → fetch; absent → fetch; failure →
     cooldown suppresses repeat fetch within 1h, retries after.
   - wire: `/api/auth/me` includes location when set; chat request still succeeds
     (200/stream) with both providers rejecting; no error surfaces.
   - injection: `user:location` envelope only when country set.
6. **Quality gate + docs**: `npm run lint`, `npm run typecheck`, `npm test`,
   `npm --prefix src/client run lint`, `npm run ci`; update this plan; open the PR
   with the XFF header note and the ip-api HTTP-only note; archive plan on merge.

## Delivered (critic pass, 2026-09-15)

- Prior commit on this branch shipped **no source code** (only `.iteration` logs);
  the whole feature was built from scratch in the critic pass.
- `src/server/services/geoLocationService.ts`: `isPrivateIp`,
  `resolveCountry` (country.is → ip-api, 2s timeout each, shape-validated, never
  throws), `ensureUserLocation` (7-day freshness, in-process 1h failure
  cooldown, `$set`-only persist, resolves in place on the passed document).
  Extras hardened beyond the plan: IPv4-mapped IPv6 checks the embedded v4
  address; CGNAT `100.64/10` and `0.0.0.0/8` treated as non-resolvable;
  country.is answer must echo back the requested IP; 2-letter codes
  normalized to uppercase at the boundary regardless of provider case.
- Model `location` subdocument (+`UserLocation` type), `AuthUser.location`
  contract, `toAuthUser` projection (never exposes `resolvedAt`).
- `/api/auth/me`: awaited `ensureUserLocation`. Chat routes (`POST /api/chat`
  - `/api/chat/stream`): **awaited** (plan said fire-and-forget — revised,
    see decision below) so the same turn's prompt deterministically includes
    the country from the freshly-resolved document.
- `promptAssembly.ts`: `user:location` envelope (`User is in <Country>
(<CC>)`) under the contextual-info intro, coarse/may-be-wrong wording, no
  envelope at all when unresolved; `RELEVANCE_RULE` covers it.
- `index.ts`: `app.set('trust proxy', TRUST_PROXY_HOPS)` (default 1, only in
  production paths that matter — hop count is deploy config; spoofing trade
  remains open question 1).
- Tests: 20-case `geoLocationService.test.ts`, promptAssembly location cases,
  `auth.contracts` wire test (location present with exactly
  `{country, countryCode}`, absent otherwise, `resolvedAt` never exposed).
  Critic-pass additions worth noting: router `data.ip !== ip` echo check,
  IPv4-mapped-IPv6, 172.32.0.1 boundary here / 172.16 boundary there,
  case-normalization of lowercase provider codes.

### Decision revision (from the plan)

- Chat wiring is **awaited**, not fire-and-forget. Fire-and-forget could not
  satisfy the acceptance criterion "Location appears in chat context" (the
  prompt race would be nondeterministic) and awaiting is bounded anyway:
  fresh/cooldown hits return in microseconds; the provider path costs ≤4s
  only once per user per 7 days (plus 1h after outages), and the service
  never throws, so chat cannot break on it.

## Open questions

1. **`trust proxy` hop count vs the plan-32 anti-spoofing stance.** live topology is
   two hops (host nginx → client nginx → backend), so `TRUST_PROXY_HOPS=2` recovers
   the real client IP — but only while the host nginx correctly overwrites (rather
   than passes through) client-supplied `X-Forwarded-For`. `plan-32` deliberately
   left `trust proxy` unset citing IP-spoofing risk; this ticket is the first
   feature that actually needs `req.ip`. The code ships env-driven (default `1`) and
   works either way, but the deploy value and the spoofing tradeoff need owner sign-off.
2. **Retry-after-failure cadence.** The ticket's "resolve once per 7 days unless
   missing" is silent on failures; never retrying makes a transient outage permanent
   for a user. Proposed: no Mongo write on failure + in-process 1h cooldown. Any
   owner preference (shorter/longer, or fail-forever) only changes a constant.
3. **Chat resolution is awaited — latency tradeoff sign-off.** The first
   authenticated request per user per week can take ≤~4s extra while both
   providers are consulted (bounded by two 2s timeouts). Rejected the plan's
   fire-and-forget wiring: the prompt race made "location appears in chat
   context" nondeterministic. Alternatives if the owner prefers zero added
   latency: resolve only from `/api/auth/me` (the client calls it on load)
   and fire-and-forget in chat — costs one turn's delay. Owner call.

{}
