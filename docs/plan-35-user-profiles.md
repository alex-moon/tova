# Plan — User profiles (issue #35)

Branch: `feat/tv/35-user-profiles`
Issue: https://github.com/alex-moon/tova/issues/35

## Motivation

Everything about a user today is email + role:

- The system prompt is a hardcoded global `SYSTEM_PROMPT` (`src/server/routes/chat.ts:148`,
  unshifted at lines 206 and 298) shared by all users.
- The `User` model (`src/server/models/User.ts`) stores `email`, `passwordHash`, `role`,
  `googleId`, `permissions` — no profile fields, no `settings` subdocument.
- The Google OAuth flow (`src/server/routes/auth.ts:131-196`) requests
  `openid email profile` but at token exchange only decodes `sub`/`email` from the
  `id_token`, discarding `name`, `picture`, and the `access_token`.
- `AuthUser` / `LoginUserPayload` in `src/shared/contracts.ts` carry only
  `id, email, role, permissions`.

The owner has additionally clarified the intent in issue comments: Tova should know
who the user is (their **preferred** name, not their full name), where they roughly
are, and inject only *relevant* profile context into the system prompt.

## Decisions (adopted)

- **Name model, per owner's comment (2026-09-13):** the Google-provided full name is
  the single source of truth for `name` and is **never user-editable**. The user's
  **`preferredName`** is a separate field that only the user sets; Tova never guesses
  it. Schema field `name` (already implemented on the branch) is styled as the Google
  full name (trimmed, ≤100 chars); add `preferredName` with the same constraints.
- **Avatar is not user-editable** (owner: "Avatar should not be editable"). `PATCH
  /api/profile` therefore never touches `name` or `avatarUrl`. Manual avatar upload
  remains #34, out of scope.
- **Google login refreshes `name` and `avatarUrl` unconditionally** on every Google
  login (both are Google-owned fields now that user edits are excluded). This
  resolves the earlier "does re-login overwrite a user-edited name?" open question —
  it is moot because user-edited display *names* no longer exist; `preferredName` is
  never written by Google.
- **Google profile data comes from the userinfo endpoint, not `id_token` claims**
  (verified against 2026-06 Google OIDC docs: `name`/`picture` in the ID token are
  "might be provided"; `https://openidconnect.googleapis.com/v1/userinfo` reliably
  returns them). The callback already receives the `access_token` and casts it away
  (`auth.ts:171`); parse it and call userinfo. No new scopes. Both `name` and
  `picture` are tolerated-absent (Google users/orgs may withhold them).
- **The userinfo call is non-fatal:** on failure, log and continue login without
  profile fields. Authentication must never break on profile enrichment.
- **Per-user system prompt lives under `user.settings.systemPrompt`**; empty/absent
  falls back to the global `SYSTEM_PROMPT`, resolved at both unshift sites.
- **Profile context is injected into the system prompt as a separate, short block**
  built from what exists: preferred name (if set), full name disclosure only if the
  user asks, location (once location lands, see Open questions). Explicit prompt
  instructions per the owner's comments: never address the user by their full name;
  surface/mention that they can set a preferred name if none is set; use profile
  info only where relevant to the conversation.
- **Contract changes are additive and optional** so both server and client keep
  typechecking (`AuthUser` gains optional `name`, `avatarUrl`, `preferredName`).
- **UI is a client-only modal opened from the sidebar footer user area** (no settings
  sheet exists; sidebar footer has only Logout and ThemeToggle). Modal contains:
  name display (read-only), preferred-name input, system-prompt textarea, Save →
  `PATCH /api/profile`, then refresh AuthContext. Location controls are added only
  after the location open questions resolve.
- Out of scope (per issue + owner): custom avatar upload (#34), prompt presets,
  per-user API keys/model preferences, behavior-based profiles from message metrics,
  and a memory mechanism (both flagged by the owner as "direction, not this ticket").

## Open questions

No planned task below depends on any of these. Location work is intentionally
deferred behind them.

1. **Which IP-geolocation source?** The owner said location would be a "rough lookup
   based on IP address", but the repo has no geo-IP library and no credentials for a
   hosted IP-geo API. Options: (a) a hosted API (needs a key/secret management),
   (b) an offline coarse DB (e.g. MaxMind GeoLite2 city/country). Either way this picks
   a dependency and, for hosted APIs, a secret. Also unresolvable locally: in local dev
   the client IP is loopback/private and has no geo answer.
2. **How does "use precise location" actually work?** Precise location can only come
   from the browser Geolocation API, which requires a per-browser permission prompt
   and user gesture; it cannot be enabled once in a profile modal and silently
   honored everywhere. Concrete sub-questions: does the profile toggle mean "the
   client asks for geolocation and sends coordinates when the user grants them in
   that browser", and is precise location re-requested each session? What happens
   when the grant is denied — fall back to rough IP location, or no location?
3. **Is rough IP location opt-in or default-on?** The owner's comment reads as
   "rough IP lookup plus an opt-in for precise". If rough location is on by default,
   that needs to be surfaced in the profile modal and possibly called out on first
   login (privacy). Confirm intended default.

## Tasks (each one commit-sized)

1. **Schema + contracts** *(done, incomplete vs the new name model — extend it)*:
   - Status on branch: `User` already has `name` + `avatarUrl` + lazy
     `settings.systemPrompt`; `AuthUser` carries optional `name`/`avatarUrl`;
     `GET /api/auth/me` projects them; drift tests in `auth.contracts.test.ts` cover
     absent/whitespace/oversize cases.
   - Remaining: add `preferredName` (optional, trimmed, ≤100, default `null`) to
     `User` and the `/me` projection and `AuthUser`; do **not** add `name` editing
     anywhere.
2. **Google avatar/name pull via userinfo**: in `/google/callback`
   (`src/server/routes/auth.ts:131-196`):
   - add `access_token` to the token-exchange response type (`auth.ts:171`);
   - fetch the userinfo endpoint with the access token; read `name` and `picture`
     (both optional, tolerate absence);
   - extend `resolveOrCreateUser` (`src/server/services/userService.ts:14`) to accept
     the profile: store both on create; on refresh overwrite `name` and `avatarUrl`
     unconditionally; never write `preferredName`;
   - userinfo failure: log, continue login without profile fields;
   - update `src/server/routes/auth.google.test.ts`: both fields stored on first
     login; refresh overwrites changed Google values; preferredName untouched;
     userinfo failure still completes login.
3. **PATCH /api/profile**: new route with a zod schema accepting only
   `preferredName` (optional trimmed ≤100) and `systemPrompt` (optional ≤4000);
   partial update — only supplied fields written; rectifies the earlier plan's
   "name" updatable field (now removed per owner decision); returns the updated
   `AuthUser`-shaped payload; requires `authenticate`. Unit tests: happy path,
   validation failure (too-long values, attempt to send `name`/`avatarUrl` ignored or
   rejected — pick and test one), unauthenticated 401.
4. **Per-user system prompt in chat routes**: at both unshift sites
   (`src/server/routes/chat.ts:206`, `:298`) resolve
   `user.settings?.systemPrompt || SYSTEM_PROMPT` through a shared helper so they
   cannot drift. Tests: user-authored prompt overrides the global default; a user
   without one gets the global default unchanged.
5. **Profile-context prompt block**: helper in
   `src/server/services/` (next to the task-4 helper) that, given the user document,
   appends a short profile block after the resolved system prompt containing only
   what exists: `preferredName` (if set), a "the user's full name is X — never
   address them by it; if they seem to want to be called something, invite them to
   set a preferred name" instruction (when full name exists and preferred name
   does not), and the owner's "do not use profile information where it is not
   relevant to the chat" instruction unconditionally. Wire into the same two unshift
   sites so the helper is the single source of prompt assembly. Tests: block present
   with/without preferred name; absent profile yields prompt byte-identical to the
   global one.
6. **Client: contracts + auth context**: refresh `AuthUser` usage
   (`src/client/src/services/auth.ts`, `src/client/src/context/AuthContext.tsx`) to
   carry optional `name`/`avatarUrl`/`preferredName`; keep the issue #20 drift notes
   intact.
7. **Client: sidebar avatar + profile modal**: footer user area in
   `src/client/src/components/Sidebar.tsx` shows name/fallback email and small
   avatar with initials fallback; clicking opens the modal: read-only name display,
   profile name input, avatar preview, system-prompt textarea, Save →
   `PATCH /api/profile`, then refresh AuthContext. Vitest coverage: modal renders
   with current values; save calls the API and updates context.
8. **Verify + docs**: run `npm run ci`; update the Done checklist; record any
   decision changes; move location follow-up into a new ticket or this ticket once
   the open questions are answered.

## Done

- [x] 1. Schema + `AuthUser` contract + `GET /api/auth/me` (partially —
      `preferredName` still to add: schema field added in #35 task-2 commit;
      `/me` projection and `AuthUser` remain)
- [x] 2. Google login stores/refreshes name + avatarUrl (userinfo endpoint) + tests
      (2026-09-13: `fetchGoogleProfile` in `auth.ts`, `resolveOrCreateUser` takes
      `profile`; Google-owned fields overwritten unconditionally, user-owned
      fields never touched; userinfo failure non-fatal)
- [ ] 3. `PATCH /api/profile` (preferredName + systemPrompt) + tests
- [ ] 4. Per-user system prompt overrides global in chat routes + test
- [ ] 5. Profile-context prompt block + tests
- [ ] 6. Client AuthContext carries name/avatarUrl/preferredName
- [ ] 7. Sidebar avatar + profile modal + tests
- [ ] 8. `npm run ci` green; plan doc current

## Follow-ups

- Location (rough IP + precise browser coords) waits on Open questions 1–3; then
  either extends this ticket or opens a new one.
- Custom avatar upload waits on #34 (asset storage); the "custom avatar wins over
  Google refresh" flag belongs to that ticket — though with avatar now non-editable,
  #34 will need its own decision from the owner on how a user changes their avatar
  at all.
- Behavior-based user profiles from message metrics: owner direction, separate ticket.
- Opt-in memory mechanism (agent decides to remember things, and tells the user):
  owner direction, separate ticket.
- Prompt presets / multiple named system prompts: schema stays open, no UI.
