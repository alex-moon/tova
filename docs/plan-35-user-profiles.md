# Plan — User profiles (issue #35)

Branch: `feat/tv/35-user-profiles`
Issue: https://github.com/alex-moon/tova/issues/35

## Motivation

Everything about a user today is email + role:

- The system prompt is a hardcoded global `SYSTEM_PROMPT` (declared at
  `src/server/routes/chat.ts:148`, unshifted at chat.ts:206 and chat.ts:298 — the
  stream route and the non-stream route) shared by all users.
- The `User` model (`src/server/models/User.ts`) historically stored `email`,
  `passwordHash`, `role`, `googleId`, `permissions` — no profile fields, no
  `settings` subdocument.
- The Google OAuth flow (`src/server/routes/auth.ts:131-196`) requested
  `openid email profile` but at token exchange only decoded `sub`/`email` from the
  `id_token`, discarding `name`, `picture`, and the `access_token`.
- `AuthUser` / `LoginUserPayload` in `src/shared/contracts.ts` carry only
  `id, email, role, permissions`.
- Client-side, `AuthContext.tsx` and `services/auth.ts` reuse `AuthUser` from the
  shared contracts directly — there is no separate client user type to drift.

The owner clarified intent in issue comments: Tova should know who the user is
(their **preferred** name, never addressed by full name), roughly where they are,
and inject only *relevant* profile context into the system prompt. Preferred name
is surfaced for the agent to use wherever appropriate; the agent should prompt the
user to set one if none exists.

## Decisions (adopted)

- **Name model (owner comment, 2026-09-13):** the Google-provided full name is the
  single source of truth for `name` and is **never user-editable**. The user's
  **`preferredName`** is a separate field only the user sets; Tova never guesses it.
- **Avatar is not user-editable** (owner: "Avatar should not be editable").
  `PATCH /api/profile` never touches `name` or `avatarUrl`. Manual avatar upload
  remains #34; note for #34: with avatar non-editable here, it needs its own owner
  decision on how a user changes their avatar at all.
- **Google login refreshes `name` and `avatarUrl` unconditionally** every Google
  login (both Google-owned now that user edits are excluded). The earlier
  "does re-login overwrite user-edited names?" question is moot by construction.
- **Google profile data comes from the userinfo endpoint**, not `id_token` claims
  (Google OIDC docs: `name`/`picture` in the ID token "might be provided";
  `https://openidconnect.googleapis.com/v1/userinfo` reliably returns them). Both
  fields tolerated-absent. Implemented: `fetchGoogleProfile` in `auth.ts` with a
  5s `AbortSignal.timeout`; `picture` bounded to 2048 chars; userinfo failure is
  logged, non-fatal — login completes without profile fields.
- **Per-user system prompt lives under `user.settings.systemPrompt`**; empty or
  absent falls back to the global `SYSTEM_PROMPT`. Resolution happens **at request
  time** in both chat routes, so edits take effect immediately for existing
  sessions — no per-session snapshot, no invalidation concern.
- **Profile context is a separate, short block appended after the resolved system
  prompt**, built only from what exists: `preferredName` (if set), the full-name
  handling instruction (when full name exists and preferred name does not), and
  unconditionally the owner's "do not use profile information where it is not
  relevant to the chat" instruction.
- **Contract changes are additive and optional** so both sides keep typechecking.

### PATCH /api/profile semantics (MVP default, see Open question 1)

Concrete request behavior, chosen so the task below does not depend on the open
question:

- `PATCH /api/profile`, requires `authenticate`, zod body accepting at most:
  `preferredName` (optional string, trimmed, ≤100 chars) and `systemPrompt`
  (optional string, ≤4000 chars).
- **Partial update:** a key *absent* from the body is untouched. A key *present*
  sets the field — trimmed empty string clears it (`preferredName: null` /
  `systemPrompt` removed). This is non-destructive for clients that only send what
  the user changed, and gives the modal's "clear" affordance for free.
- Unknown keys (including `name`, `avatarUrl`, `email`, `role`) are **rejected**
  (zod `strict()`), not silently ignored — a client bug must not pretend success
  while dropping data. Tests assert the 400.
- Returns the updated `AuthUser`-shaped payload.

### Limits (see Open question 2)

`preferredName` ≤100 chars and `systemPrompt` ≤4000 chars are limits invented in
this plan (schema bound on `name` ≤100 and `avatarUrl` bound 2048 are already
implemented and tested). Treat the invented ones as provisional; adjust if the
owner answers Open question 2 differently.

### Location — deferred to a new ticket (owner-approved, 2026-09-13)

Not part of this ticket's tasks. The owner approved spinning the location work
into its own ticket. Decisions already captured from issue comments (the new
ticket should adopt these directly, do not re-ask):

- **Rough IP geo source:** country.is or ip-api.com; **country level is fine**
  ("keep it simple") — the new ticket picks one of the two.
- **Precise location mechanics:** confirmed — it comes from the browser
  Geolocation API, sent from the front end, and the browser permission prompt is
  confirmed by the user every time it is needed. The profile opt-in toggle's
  meaning: **if opted out, the client never asks the browser for permission at
  all**; if opted in, permission is requested (per browser, per grant).
- **Rough IP location is opt-out** (on by default).
- **The raw IP address itself is NEVER sent to LLMs** — only the derived
  country/location.
- Profile info enters the chat only via the system prompt and only where relevant.

## Open questions

No planned task depends on either — both state an MVP default above; the answers
would adjust defaults, unblock nothing.

1. **PATCH clearing semantics:** present-but-empty means "clear" per the MVP
   default above, and unknown keys are rejected with 400. Confirm, or specify
   explicit-null clearing / silent-ignore instead.
2. **Confirm invented limits:** is `preferredName` ≤100 and `systemPrompt` ≤4000
   acceptable, or should these differ (or be uncapped with a sanity bound)?

## Tasks (each one commit-sized)

1. **Schema + contracts** *(done, complete)*:
   - `User` has `name` + `avatarUrl` + `preferredName` (optional, trimmed, ≤100,
     default `null`) + lazy `settings.systemPrompt` (`User.ts:38-56`); `AuthUser`
     carries optional `name`/`avatarUrl`/`preferredName` (`contracts.ts:42-43`);
     `GET /api/auth/me` projects all three; drift tests in
     `auth.contracts.test.ts` cover absent/whitespace/oversize cases. No `name`
     editing exists anywhere.

2. **Google avatar/name pull via userinfo** *(done, complete)*:
   - `fetchGoogleProfile` (`auth.ts:21-40`) fetches userinfo with the access
     token, reads `name`/`picture` tolerantly (trimmed ≤100 / ≤2048), 5s timeout,
     failure non-fatal; the token-exchange response type includes `access_token`;
     `resolveOrCreateUser` (`userService.ts:14`) takes `profile` and stores both
     on create, overwrites both on refresh, never writes user-owned fields
     (`preferredName`, `settings`). Tests in `auth.google.test.ts`: first-login
     storage, refresh overwrites changed Google values, preferredName untouched,
     userinfo failure completes login, hostile payloads bounded.

3. **PATCH /api/profile** — in `src/server/routes/auth.ts` (or a small
   `src/server/routes/profile.ts` mounted from the router registration site where
   `admin.ts`/`feedback.ts` mounts are):
   - zod schema per "PATCH semantics" above (`strict()`, trimmed ≤100 /
     ≤4000, empty-string clears);
   - `partial: true`-style writes: only supplied keys; use
     `user.preferredName = value ?? null` and for `systemPrompt` set or
     `$unset`-equivalent (`user.settings.systemPrompt = undefined` under mongoose
     strict mode removes it — verify with a test that `settings.systemPrompt`
     round-trips as absent after clear);
   - `requireAdmin`-style route wiring: `authenticate` middleware, 401 JSON shape
     matching existing routes;
   - re-fetch the user document and return the same payload shape as `/me`
     (single shared projection helper if cheap, otherwise mirror `/me`'s fields
     and add a drift test asserting `GET /me` and PATCH responses carry identical
     field sets);
   - unit tests: happy path set; clear via empty string; absent keys untouched
     (pre-existing preferredName survives a `systemPrompt`-only PATCH);
     validation failure (too-long, non-string); strict rejection of
     `name`/`avatarUrl`/`role` → 400; unauthenticated → 401.

4. **Per-user system prompt in chat routes** — in `src/server/routes/chat.ts`:
   - add a shared helper (e.g. `resolveSystemPrompt(user)` in
     `src/server/services/userService.ts` or a small `promptAssembly` service)
     returning `user.settings?.systemPrompt?.trim() || SYSTEM_PROMPT`; trim so a
     whitespace-only prompt cannot disable the system message;
   - replace the `SYSTEM_PROMPT` literal at both unshift sites (chat.ts:206 and
     chat.ts:298) with the helper so the stream and non-stream routes cannot
     drift;
   - tests: user-authored prompt overrides global in both routes (stream route
     covered via the existing `chat.stream.test.ts` harness); whitespace-only
     setting falls back to global; user without a setting is byte-identical to
     today's behavior.

5. **Profile-context prompt block** — same assembly helper as task 4 becomes the
   single prompt-assembly point (`buildSystemMessages(user)` returning the full
   system content: resolved prompt + optional profile block):
   - block contains, only when present: "the user goes by `preferredName`" line;
     when full name exists but preferred name does not: "the user's full name is
     X — never address them by it; if they seem to want to be called something,
     invite them to set a preferred name";
     unconditionally: "profile details are context, not conversation material —
     use them only where relevant, and never reveal the raw profile fields";
   - wire into both unshift sites via the same helper;
   - tests: block present with preferred name set; instruction-only block when
     full name exists without preferred name; no profile data at all →
     byte-identical to the resolved prompt (byte-equality assertion, not
     substring).

6. **Client: contracts + auth context** — *smaller than originally planned*:
   the client already types users via `AuthUser` from `@shared/contracts`
   (`AuthContext.tsx:3`, `services/auth.ts:2`), so contracts changes propagate
   automatically. Remaining work: verify no client code assumes the user object
   is exactly `{id,email,role,permissions}` (grep for property narrowing), keep
   the issue #20 drift notes intact, and add/extend a client test if `AuthContext`
   has one covering user shape.

7. **Client: sidebar avatar + profile modal** — in
   `src/client/src/components/Sidebar.tsx` (footer user area currently holds only
   Logout and ThemeToggle):
   - footer shows small avatar (image or initial-colored fallback) + display name
     (preferredName → name → email, per owner: never address by full name in
     chat; in sidebar UI the Google name may display once, email fallback);
   - a `ProfileModal` component (new file, alongside Sidebar): read-only name +
     avatar display (not an "avatar preview" edit affordance — avatar is not
     editable), preferred-name input, system-prompt textarea, Save →
     `PATCH /api/profile` via a new `updateProfile` in `services/auth.ts`, then
     `refresh()`-style context update; error state surfaces API validation
     failures; disabled Save while pending;
   - no location controls (deferred ticket);
   - Vitest: modal renders pre-filled with context values; save calls `PATCH`
     with only changed fields and updates context; API error shows a message and
     keeps the modal open.

8. **Verify + docs**: `npm run ci` (server lint, format check, typecheck, server
   tests, client lint/format/tests, client build); update this checklist;
   confirm Open questions 1–2 on #35 (posted 2026-09-13) once answered; move to
   `docs/done/` at merge per workflow.

## Done

- [x] 1. Schema + `AuthUser` contract + `GET /api/auth/me` (critic pass added
      `preferredName` to `/me` projection, `AuthUser`, and round-trip tests)
- [x] 2. Google login stores/refreshes name + avatarUrl (userinfo endpoint) + tests
      (`fetchGoogleProfile`, 5s timeout, size bounds, non-fatal failure)
- [ ] 3. `PATCH /api/profile` (preferredName + systemPrompt, strict body, empty
      clears) + tests
- [ ] 4. Per-user system prompt via shared resolver at both unshift sites + tests
- [ ] 5. Profile-context prompt block via shared assembly helper + tests
- [ ] 6. Client AuthContext carries name/avatarUrl/preferredName (contracts auto-
      propagate; verify no narrowing assumptions + drift notes intact)
- [ ] 7. Sidebar avatar + profile modal + tests
- [ ] 8. `npm run ci` green; plan doc current; Open questions 1–2 answered

## Follow-ups

- **Location ticket (owner-approved new ticket):** adopt the captured decisions in
  the "Location" section above; remaining work there: pick country.is vs
  ip-api.com, server-side opt-out lookup, profile toggle + first-run privacy surfacing
  for rough location, precise-location client flow, and the never-send-raw-IP rule.
  Unresolved locally: loopback/dev IPs have no geo answer — dev can skip or mock.
- Custom avatar upload waits on #34 (asset storage); #34 needs an owner decision on
  how a user changes their avatar at all now that avatar is non-editable here.
- Behavior-based user profiles from message metrics: owner direction, separate ticket.
- Opt-in memory mechanism (agent decides to remember things, tells the user):
  owner direction, separate ticket.
- Prompt presets / multiple named system prompts: schema stays open, no UI.
