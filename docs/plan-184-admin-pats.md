# Plan — #184 Admin PATs

## Motivation

The local agent (opencode) needs first-class admin API access to pull
diagnostics. Today's only path is register → promote in Mongo → login →
carry a 7-day cookie: stateful, out-of-band, not a real credential.
Owner steer (2026-09-27): generate GitHub-style personal access tokens in
the admin view, copy-paste into local `.env`, revoke at will.
GitHub issue: alex-moon/tova#184.

## Decisions

- **PATs, not a static `ADMIN_API_KEY` env** (owner steer): no server-side
  secret at all — tokens live hashed in Mongo, revocable per token.
- **Token format**: `tova_pat_` + base64url(32 random bytes). sha256 digest
  at rest (`tokenHash`, unique index); plaintext returned exactly once, in
  the create response only.
- **Role is live, not baked in**: the middleware loads the creator's current
  role on every request, so demoting a user demotes their PATs immediately.
  This mirrors the app's existing "live role/permission changes reflected on
  every read" stance in `/api/auth/me`.
- **Scoped to admin routes**: `authenticateBearerOrSession` replaces
  `authenticate` in the admin guard only. PATs do not open chat/profile
  flows in this ticket; generalizing is a possible follow-up.
- **Revocation = row deletion**: revoke is DELETE `/api/admin/pats/:id`;
  the next request with that token 401s. No flags, no tombstones.
- **`expiresAt` optional**: blank = non-expiring (the `.env`-paste use case
  wants long-lived).
- **`lastUsedAt`** updated fire-and-forget on each Bearer request — the
  Access tab shows it, so a stale PAT is visible at a glance.

## Done

- [x] `Pat` model (`src/server/models/Pat.ts`) with unique `tokenHash` index
- [x] `authenticateBearerOrSession` middleware (`src/server/middleware/auth.ts`)
- [x] Routes: GET/POST/DELETE `/api/admin/pats` (`src/server/routes/adminPats.ts`)
- [x] `createPatSchema` validation + shared contract types
- [x] Admin "Access" tab: list, generate (one-time token box + copy), revoke
- [x] Client service + types (`AdminPatsService`)
- [x] `.env.example` `TOVA_PAT` entry + AGENTS.md agent usage note
- [x] Server + client tests
- [x] `npm run ci` green
- [x] PR opened

## Follow-ups

- #179 logs CLI will read `TOVA_PAT` from `.env` and send
  `Authorization: Bearer` against `/api/admin/logs`.
- Generalising Bearer auth beyond admin routes (e.g. chat API for agent
  evals) is deliberately out of scope here.
