# Plan — User profiles (issue #35)

Branch: `feat/tv/35-user-profiles`
Issue: https://github.com/alex-moon/tova/issues/35

## Motivation

Everything about a user today is email + role:

- The system prompt is a hardcoded global `SYSTEM_PROMPT` (`src/server/routes/chat.ts:148`,
  used at lines 206 and 298) shared by all users.
- The `User` model (`src/server/models/User.ts`) stores `email`, `passwordHash`, `role`,
  `googleId`, `permissions` — no display name, no avatar, no per-user settings, no
  `settings` subdocument at all yet.
- The Google OAuth flow (`src/server/routes/auth.ts:131-196`) already requests
  `openid email profile` (scope set at the authorize call) but at the token exchange
  (`auth.ts:171-182`) it only parses `id_token` out of the response body and decodes
  only `sub`/`email` from the payload, discarding `name`, `picture`, **and** the
  `access_token` that comes back alongside it.
- `AuthUser` / `LoginUserPayload` in `src/shared/contracts.ts` carry only
  `id, email, role, permissions`.

Personalizing Tova should start here: per-user system prompt, profile fields, and the
Google-provided profile data we already have access to.

## Decisions so far

(Adopt unless contradicted during implementation; each cites its source.)

- **Schema is migration-free (Mongo)**, extending `src/server/models/User.ts`. The
  `settings` subdocument is created lazily on first write (Mongoose handles missing
  nested paths; no backfill migration needed).
- **Google profile data comes from the userinfo endpoint, not `id_token` claims.**
  Verified against current Google docs (2026-06 revisions of
  `developers.google.com/identity/openid-connect/reference` + the Discovery document
  in `.../openid-connect/openid-connect`): with the `profile` scope, `name`/`picture`
  in the `id_token` are only "might be provided", while the userinfo endpoint
  (`https://openidconnect.googleapis.com/v1/userinfo` — the `userinfo_endpoint` in
  Google's Discovery doc) reliably returns `name` and `picture`. The callback already
  receives the `access_token` in the token-exchange response (`auth.ts:171` currently
  casts it away); add `access_token` to the parsed type and call userinfo there. No
  new scope is requested (`email profile` is already in the authorize URL). This was
  an explicit instruction in the issue body ("confirm against current docs rather
  than assuming") — done, resolution recorded here.
- **Per-user system prompt lives under `user.settings.systemPrompt`** (as the issue
  specifies); empty/absent falls back to the global `SYSTEM_PROMPT`, resolved at both
  unshift sites in `chat.ts`.
- **`PATCH /api/profile`** (zod-validated) is the only new API surface; updatable
  fields per the issue: name, systemPrompt. Avatar is managed by the Google-login
  refresh path, not by this endpoint (manual upload is #34, later).
- **Google login always refreshes `name` + `avatarUrl` in MVP.** Rationale: manual
  avatar upload doesn't exist yet (#34), so there is no "user has set a custom
  avatar" state to protect, and the issue's acceptance criteria say Google login
  populates name + avatar "on refresh". The "unless the user has set a custom avatar"
  caveat from the issue applies only once #34 lands — no flag is added now. (See
  Open questions for the one unresolved edge: user-*edited* display names.)
- **Contract changes are additive and optional** so both server and client keep
  typechecking (`AuthUser` gets optional `name`/`avatarUrl`).
- **UI surface is a client-only modal opened from the footer user area.** The issue
  says "reuse the existing settings sheet surface if one exists; otherwise a minimal
  page/modal". Repo check: no settings sheet exists — the sidebar footer only has
  Logout and ThemeToggle — so we build the minimal modal rather than inventing a
  settings framework. A dedicated page would be more churn for no benefit at this
  scope.
- Out of scope (per issue): custom avatar upload (#34), prompt presets, per-user API
  keys or model preferences.

## Open questions

- **Does a subsequent Google login overwrite a user-edited display name?** The issue
  says Google populates name + avatar "first login and on refresh", and `PATCH
  /api/profile` lets the user edit `name` — but these collide: if a Google user edits
  their name and then logs in again, the refresh (decision above) would revert it.
  The issue's "unless the user has set a custom avatar" carve-out is written about
  avatars only. Interpretation for now: MVP refreshes `avatarUrl` on every Google
  login but sets `name` only when it is currently empty, so a user-edited name
  survives. Asking on the issue to confirm.

## Tasks (each one commit-sized)

1. **Schema + contracts**: add `name` (optional, trimmed, ≤100 chars) and
   `avatarUrl` (optional, string) to `User`;
   add `settings.systemPrompt` (optional, ≤4000 chars) inside a lazily-created
   `settings` subdocument. Add optional `name` / `avatarUrl` to `AuthUser` in
   `src/shared/contracts.ts`. Extend `GET /api/auth/me` (`src/server/routes/auth.ts:212-217`)
   to include them when present. Update any contract-drift comments if needed.
   Tests: `GET /me` round-trips the new fields; absent fields stay absent.
2. **Google avatar/name pull via userinfo**: in `/google/callback` (`src/server/routes/auth.ts:131-196`):
   - add `access_token` to the token-exchange response type (`auth.ts:171`);
   - fetch `https://openidconnect.googleapis.com/v1/userinfo` with the access token;
   - read `name` and `picture` from the response (both optional — the Google docs
     note users/orgs may withhold fields; tolerate their absence);
   - extend `resolveOrCreateUser` (`src/server/services/userService.ts:14`) to take
     the profile and store on create; on refresh, always update `avatarUrl`, set
     `name` only if currently empty (pending confirmation in Open questions);
   - keep the userinfo call non-fatal: if it fails, log and continue login without
     profile fields (profile data must not break authentication);
   - update/join the existing google-route test (`src/server/routes/auth.google.test.ts`):
     happy path storing both fields on first login, refresh updates avatar,
     userinfo failure still completes login.
3. **PATCH /api/profile**: new route in `src/server/routes/` with a zod schema
   (`name`: optional trimmed string ≤100; `systemPrompt`: optional string ≤4000);
   partial update — only supplied fields are written; returns the updated
   `AuthUser`-shaped payload; requires `authenticate`. Unit tests: happy path,
   validation failure (too-long values), unauthenticated 401.
4. **Per-user system prompt in chat routes**: at both unshift sites
   (`src/server/routes/chat.ts:206`, `:298`) resolve
   `user.settings?.systemPrompt || SYSTEM_PROMPT` into a local before the unshift.
   Tests: a user-authored prompt overrides the global default for that user; a user
   without one gets the global default unchanged; the two sites share the resolution
   helper so they cannot drift.
5. **Client: contracts + auth context**: refresh the client's `AuthUser` usage
   (`src/client/src/services/auth.ts`, `src/client/src/context/AuthContext.tsx`) to
   carry optional name/avatarUrl; keep the issue #20 drift notes intact.
6. **Client: sidebar avatar + profile modal**: footer user area in
   `src/client/src/components/Sidebar.tsx` shows name (fallback: email) and a small
   avatar with an initials fallback for users without one. Clicking it opens the
   modal: name input, avatar preview, system-prompt textarea, Save →
   `PATCH /api/profile`, then refreshes AuthContext state so the sidebar updates.
   Vitest coverage: modal renders with current values, save calls the API and
   updates context.
7. **Verify + docs**: run `npm run ci`; update this plan's Done checklist; note any
   decisions changed above (including the outcome of the name-refresh open question).

## Done

- [ ] 1. Schema + `AuthUser` contract + `GET /api/auth/me`
- [ ] 2. Google login stores/refreshes name + avatarUrl (userinfo endpoint) + tests
- [ ] 3. `PATCH /api/profile` with zod validation + tests
- [ ] 4. Per-user system prompt overrides global in chat routes + test
- [ ] 5. Client AuthContext carries name/avatarUrl
- [ ] 6. Sidebar avatar + profile modal + tests
- [ ] 7. `npm run ci` green; plan doc current

## Follow-ups

- Custom avatar upload waits on #34 (asset storage); the "custom avatar wins over
  Google refresh" flag belongs to that ticket, not this one.
- Prompt presets / multiple named system prompts: schema stays open, no UI.
- Per-user API keys and model preferences: separate ticket.
