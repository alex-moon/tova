# Plan — User profiles (issue #35)

Branch: `feat/tv/35-user-profiles`
Issue: https://github.com/alex-moon/tova/issues/35

## Motivation

Everything about a user *was* email + role (line references below are the
pre-implementation state and have drifted since — the prompt assembly now lives
in `src/server/services/promptAssembly.ts`; kept as historical context):

- The system prompt was a hardcoded global `SYSTEM_PROMPT` (declared at
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
  `systemPrompt: null`). Implementation note (critic pass 2026-09-13): the
  cleared prompt round-trips as the schema default `null`, not `undefined` —
  mongoose rehydrates an absent subdoc field as its default on reload. The
  resolver (`promptAssembly.ts`) treats `null`, `undefined`, empty, and
  whitespace-only exactly the same, so downstream behavior is unaffected.
  Tested against `null` so the assertion cannot flake.
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

A second 2026-09-13 critic pass (this update) found **no new questions**: the
new tests (cross-user isolation, request-time resolution via PATCH, non-object
PATCH bodies) all passed against the existing implementation, and `npm run ci`
is fully green with them (248 server tests). The four questions below remain
open; Q1, Q2, and Q4 were already posted to #35, and Q3 needs owner action
(not an answer) — rotate the compromised credentials and/or confirm they were
intentional. Q3's blob is **still present in branch history** as of this pass.

A third question was surfaced by the 2026-09-13 critic pass (see below); it does
not block tasks 6–7 but needs an owner answer before merge.

1. **PATCH clearing semantics:** present-but-empty means "clear" per the MVP
   default above, and unknown keys are rejected with 400. Confirm, or specify
   explicit-null clearing / silent-ignore instead.
2. **Confirm invented limits:** is `preferredName` ≤100 and `systemPrompt` ≤4000
   acceptable, or should these differ (or be uncapped with a sanity bound)?
3. **SECURITY — committed `.env.swp` contains live secrets.** Commit `0bb28d5`
   on this branch committed a vim swap file (`.env.swp`) holding what appear to
   be the real `MONGODB_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `ADMIN_PASSWORD`, and
   DO Spaces keys. The working-tree file was deleted by the critic pass, but the
   blob remains in the branch history and the branch is pushed. Regardless of
   the answer below, all those credentials should be treated as compromised and
   rotated, and the file removed from history before merge. Question:
   confirm-and-rotate, or explain why these are intentionally committed (they do
   not match any tracked `.env*` pattern in the repo).
4. **Prompt-injection surface in the profile-context block:** `name`,
   `preferredName` come from user/Google-provided strings and are interpolated
   verbatim into the system message (e.g. a preferred name could carry
   instructions like `Ignore previous rules and …`). MVP accepts this risk —
   it is bounded to ≤100 chars, and chat content is a bigger injection surface
   anyway. Should the MVP sanitize instead (strip newlines / instruction-like
   content), or is acceptance fine?

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

3. **PATCH /api/profile** *(done, complete — implemented in
   `src/server/routes/profile.ts`, mounted from the router registration site)*:
   as spec'd in "PATCH semantics" above. Implementation note superseded by the
   critic fix: clearing sets `user.settings.systemPrompt = null` explicitly
   (the original "$unset-equivalent / `undefined` removes it" approach was
   wrong under the schema default and broke `tsc`). Tests in    `profile.test.ts`
   cover the full matrix. Critic pass 2 (2026-09-13) added 400-coverage for
   **non-object bodies** (array / string / number / boolean) — `z.strictObject`
   rejects them all — and pins `{}` as a legal no-op PATCH returning 200.

4. **Per-user system prompt in chat routes** *(done, complete)* — as planned:
   `resolveSystemPrompt` and `buildSystemContent` live in
   `src/server/services/promptAssembly.ts`; the literal `SYSTEM_PROMPT` unshift
   sites in both chat routes now use them. Tests: `chat.test.ts` and
   `chat.stream.test.ts` cover global fallback, override, whitespace-only
   fallback, and byte-equality for no-profile users. Critic pass 2
   (2026-09-13) added `chat.test.ts` tests for **cross-user prompt isolation**
   (user B's request must never see user A's override) and **request-time
   resolution through the real PATCH route** (set override → chat shows it →
   `PATCH {systemPrompt: ''}` → very next message falls back to global, with
   the mock cleared between requests).

5. **Profile-context prompt block** *(done, complete)* — same assembly helper;
   tests in `promptAssembly.test.ts` (block with preferred name, full-name
   instruction, byte-equality with no profile data).

6. **Client: contracts + auth context** — *smaller than originally planned*:
   the client already types users via `AuthUser` from `@shared/contracts`
   (`context/AuthContext.tsx:3`, `services/auth.ts:3`), so contracts changes
   propagate automatically. (Earlier plan text referenced `AuthContext.tsx` under
   `components/` — it actually lives in `src/client/src/context/`.) Concrete
   remaining steps:
   - grep the client for narrowing assumptions on the user object
     (`rg -n "user\.(id|email|role|permissions)" src/client`) and confirm nothing
     destructures the exact field set (a missing-key destructure is fine; an
     exhaustive check would not be);
   - confirm the issue #20 drift comments in `services/auth.ts` are intact;
   - `AuthContext` exposes only `{ user, loading, login, register, logout }` —
     no `refresh()`-style method exists (the earlier plan wording invented one).
     Task 7's save needs a way to push the PATCH result into context: add an
     explicit `setUser`-wrapping `updateUser(next: User)` to the context value
     and its type, rather than mutating `user` ad hoc from the modal;
   - extend `App.test.tsx` / AuthContext coverage only if the user-shape
     assertions exist — otherwise covered by server round-trip tests.

7. **Client: sidebar avatar + profile modal** — in
   `src/client/src/components/Sidebar.tsx` (footer user area currently holds
   only Logout and ThemeToggle, `Sidebar.tsx:93-95`). Concrete steps:
   - footer: small avatar — `avatarUrl` `<img>` when present, else an
     initial-colored fallback `<div>` (derive the initial from the display
     name's first character); display name = `preferredName ?? name ?? email`;
     this is UI-only, so the Google full name may display here (the
     never-address-by-full-name rule applies to the chat prompt, not the UI);
   - new `ProfileModal.tsx` alongside Sidebar, opened from the footer user
     area: read-only name + avatar rows (display-only, no edit affordance —
     avatar is not editable per owner decision), `preferredName` text input
     (maxlength 100), `systemPrompt` textarea (maxlength 4000);
   - `services/auth.ts`: add `updateProfile(patch: { preferredName?: string;
     systemPrompt?: string })` doing `PATCH /api/profile` with the `authenticate`
     header pattern the other service methods use;
   - Save sends only fields the modal has values for (empty input → send the
     empty string to trigger server-side clearing); on success call the
     `updateUser` context method from task 6 with the PATCH response and close;
     disabled Save while pending;
   - error state surfaces the API's validation message and keeps the modal open;
   - no location controls (deferred ticket);
   - Vitest: modal renders pre-filled with context values; save calls `PATCH`
     with the expected payload and updates context; API error shows a message
     and keeps the modal open; avatar fallback renders the initial when
     `avatarUrl` is absent.

8. **Verify + docs**: `npm run ci` (proved fully green, including the client
   build with the server-side scope complete — re-run after tasks 6–7); update
   this checklist; confirm Open questions 1–2 on #35 (posted 2026-09-13) once
   answered; move to `docs/done/` at merge per workflow.

## Done

- [x] 1. Schema + `AuthUser` contract + `GET /api/auth/me` (critic pass added
      `preferredName` to `/me` projection, `AuthUser`, and round-trip tests)
- [x] 2. Google login stores/refreshes name + avatarUrl (userinfo endpoint) + tests
      (`fetchGoogleProfile`, 5s timeout, size bounds, non-fatal failure)
- [x] 3. `PATCH /api/profile` (preferredName + systemPrompt, strict body, empty
      clears) + tests (critic pass 2026-09-13: fixed the typecheck failure that
      broke 8 suites, corrected the clear round-trip to `null`, added the full
      missing suite — happy/partial/clear/strict-reject/validation/401/me-drift)
- [x] 4. Per-user system prompt via shared resolver at both unshift sites + tests
      (critic pass added route-level tests for both chat routes: global
      fallback, override, profile block, whitespace-only fallback)
- [x] 5. Profile-context prompt block via shared assembly helper + tests
      (critic pass added `promptAssembly.test.ts`: byte-equality for no-profile
      users, full-name instruction, preferred-name lines)
- [x] 6. Client AuthContext carries name/avatarUrl/preferredName (contracts auto-
      propagate; verified no narrowing assumptions — `AdminView`'s `user.*`
      accesses are its own list-row type, not `AuthContext` — and drift notes
      intact). Added `systemPrompt` to `AuthUser` + `toAuthUser` (needed for
      modal prefill; settings subdoc stays internal) and an `updateUser`
      context method for pushing PATCH results.
- [x] 7. Sidebar avatar + profile modal + tests (`Sidebar.test.tsx` covers the
      img/fallback-initial rendering and opening the modal;
      `ProfileModal.test.tsx` covers prefill, trimmed PATCH payload + context
      update, empty-string clearing, and error handling that keeps the modal
      open). Related tests updated: `profile.test.ts` and
      `auth.contracts.test.ts` now expect `systemPrompt` on the wire payload.
- [ ] 8. `npm run ci` green (re-proved 2026-09-13, critic pass 2, after the
      isolation/resolution/shape tests: 248 server
      + 44 client tests, lint, format, typecheck, build); plan doc current;
      Open questions 1–2 answered

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
