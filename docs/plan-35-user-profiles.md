# Plan — User profiles (issue #35)

Branch: `feat/tv/35-user-profiles`
Issue: https://github.com/alex-moon/tova/issues/35

## Motivation

Everything about a user today is email + role:

- The system prompt is a hardcoded global `SYSTEM_PROMPT` (`src/server/routes/chat.ts:148`,
  used at lines 206 and 298) shared by all users.
- The `User` model (`src/server/models/User.ts`) stores `email`, `passwordHash`, `role`,
  `googleId`, `permissions` — no display name, no avatar, no per-user settings.
- The Google OAuth flow (`src/server/routes/auth.ts:131-196`) already requests
  `openid email profile` but decodes only `sub`/`email` from the `id_token` payload and
  discards name and picture.
- `AuthUser` / `LoginUserPayload` in `src/shared/contracts.ts` carry only
  `id, email, role, permissions`.

Personalizing Tova should start here: per-user system prompt, profile fields, and the
Google-provided profile data we already have access to.

## Decisions so far

(Learned from the issue; adopt unless contradicted during implementation.)

- Schema is migration-free (Mongo), extending `src/server/models/User.ts`.
- Google profile data comes from the OAuth callback we already run; no new auth scope
  is added (`email profile` is already requested at `auth.ts:116`).
- Per-user system prompt lives under `user.settings.systemPrompt`; empty/absent falls
  back to the global constant — resolved where `SYSTEM_PROMPT` is used today.
- `PATCH /api/profile` (zod-validated) is the only new API surface; avatar is managed
  by the Google-login refresh path, not by this endpoint (manual upload is #34, later).
- Contract changes are additive and optional so both server and client keep
  typechecking (`AuthUser` gets optional `name`/`avatarUrl`).
- Out of scope (per issue): custom avatar upload (#34), prompt presets, per-user API
  keys or model preferences.

## Open questions

- Which exact Google surface to use for name/picture: the `id_token` payload carries
  `name` / `picture` claims for `openid email profile` flows, but the issue asks to
  verify against current Google docs rather than assume (their userinfo API surface has
  moved around). Implementation must check Google's current docs (bx lookup) before
  wiring; the choice determines whether we decode id_token claims or call the userinfo
  endpoint. Small task 2 below is written to accommodate either.
- How "user has set a custom avatar" is represented in MVP: manual upload does not
  exist yet (#34), so the natural rule is "Google always refreshes `avatarUrl`".
  If a flag seems needed, defer it to #34 rather than speculating here.
- Sidebar profile/settings surface: there is no settings sheet today (only Logout and
  ThemeToggle in the footer). Plan assumes a minimal client-only modal/sheet opened
  from the footer user area rather than a separate page; final placement decided
  during implementation.

## Tasks (each one commit-sized)

1. **Schema + contracts**: add `name` (optional, trimmed, ~100 char max), `avatarUrl`
   (optional), and `settings.systemPrompt` (optional, max ~4000 chars) to the User
   schema; add optional `name` / `avatarUrl` to `AuthUser` in
   `src/shared/contracts.ts`; make `GET /api/auth/me` return them
   (`src/server/routes/auth.ts:212-217`). Update any contract-drift comments if needed.
2. **Google avatar/name pull**: in the `/google/callback` handler, source `name` and
   `picture` from whichever Google surface the docs check (open question 1) resolves
   to; pass them through `resolveOrCreateUser` (`src/server/services/userService.ts`)
   to store on create and refresh on subsequent logins. Update/join the existing
   google-route test (`src/server/routes/auth.google.test.ts`).
3. **PATCH /api/profile**: new route in `src/server/routes/` with a zod schema
   (name, systemPrompt; both optional, validated lengths); updates only fields
   supplied, returns updated `AuthUser`-shaped payload; requires
   `authenticate`. Unit tests: happy path, validation failure, unauthenticated.
4. **Per-user system prompt in chat routes**: resolve
   `user.settings.systemPrompt || SYSTEM_PROMPT` at both unshift sites
   (`src/server/routes/chat.ts:206`, `:298`); add a test proving a user-authored
   prompt overrides the global default and that users without one are unaffected.
5. **Client: contracts + auth context**: refresh the client's `AuthUser` usage
   (`src/client/src/services/auth.ts`, `src/client/src/context/AuthContext.tsx`) to
   carry optional name/avatarUrl; keep the issue #20 drift notes intact.
6. **Client: sidebar avatar + profile modal**: footer user area in
   `src/client/src/components/Sidebar.tsx` shows name (fallback: email) and small
   avatar (or initials fallback); opens a minimal profile dialog with name input,
   avatar preview, system-prompt textarea, save via `PATCH /api/profile`, which also
   refreshes AuthContext state. Vitest coverage for render + save flow.
7. **Verify + docs**: run `npm run ci`; update this plan's Done checklist; note any
   decisions changed above.

## Done

- [ ] 1. Schema + `AuthUser` contract + `GET /api/auth/me`
- [ ] 2. Google login stores/refreshes name + avatarUrl
- [ ] 3. `PATCH /api/profile` with zod validation + tests
- [ ] 4. Per-user system prompt overrides global in chat routes + test
- [ ] 5. Client AuthContext carries name/avatarUrl
- [ ] 6. Sidebar avatar + profile modal + tests
- [ ] 7. `npm run ci` green; plan doc current

## Follow-ups

- Custom avatar upload waits on #34 (asset storage).
- Prompt presets / multiple named system prompts: schema stays open, no UI.
- Per-user API keys and model preferences: separate ticket.
