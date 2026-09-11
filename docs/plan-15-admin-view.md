# Plan: #15 Admin view

## Motivation

From [issue #15](https://github.com/alex-moon/tova/issues/15): add a new
`admin` permission that grants access to an admin view where the owner can
manage users (and later other things, e.g. models).

Repo state on branch `feat/tv/15-admin-view` (verified, not just issue
comments):

- `src/server/models/User.ts` already has `role: 'user' | 'admin'`
  (enum, default `'user'`) and `permissions: string[]`.
- `src/server/middleware/auth.ts:31` already defines `requireRole(...roles)`
  but **nothing uses it** — there is no admin API surface at all.
- There is **no frontend router**; `src/client/src/App.tsx` is a single-page
  chat UI. No admin UI exists anywhere.
- Prior art: `docs/plan-3-user-permissions.md` (permissions system, OAuth,
  admin seed migration) — admin is already seeded as `formsatz@gmail.com`
  with `role: 'admin'` and the `routing` permission.

So the ticket splits into: (a) an admin-guarded backend API for user
management, and (b) a frontend admin view rendered only for admin users.

## Decisions so far

- **Use the existing `role: 'admin'` + `requireRole` middleware** rather
  than adding a separate `admin` entry to `permissions`. The issue says
  "a new permission: admin", but the codebase already distinguishes
  `role` (identity-level, currently only admin) from `permissions`
  (feature grants like `routing`). `admin` as a feature permission would
  duplicate what `role` already encodes. Admin API routes will be guarded
  by `requireRole('admin')`.
- **No react-router.** The client is a single page; adding the admin view
  as a conditional view in `App.tsx` (like the login/chat switch already
  works) means admin is reachable via a small button/toggle for admin
  users rather than a URL route. Keeping this avoids a new dependency for
  now.
- **Model management is out of scope** — the issue explicitly defers it
  ("when we have them later").

## Steps

Each step is scoped to a single reviewable commit.

- [ ] 1. Backend: `GET /api/admin/users` — list users (`email`, `role`,
      `permissions`, `googleId` presence, timestamps), guarded with
      `requireRole('admin')`. Return 403 for non-admins.
- [ ] 2. Backend: permission + role mutation endpoints —
      `PUT /api/admin/users/:id/permissions` (set full permissions array,
      `$addToSet`/`$pull` for `routing` in practice) and
      `PUT /api/admin/users/:id/role` (toggle user/admin). Guard both;
      refuse demoting the last admin (simple count check).
- [ ] 3. Frontend: expose `permissions` on `/api/auth/me` so the client
      knows who is admin (JWT payload already carries `role`; extend
      `me` response, not the token).
- [ ] 4. Frontend: admin view — conditional "Admin" section in `App.tsx`
      visible only for `role === 'admin'`; user table with email, role,
      permissions badges; actions to grant/revoke `routing` and toggle
      admin role. Reuse existing client conventions (components dir,
      fetch helpers used by AuthContext/chat).
- [ ] 5. Tests — server: admin guard (403/200), permission + role
      mutation, last-admin protection (Jest + supertest, matching
      `chat.permissions.test.ts` pattern). Client: admin section
      renders/hides per role (Vitest, matching `App.test.tsx`).
- [ ] 6. Verify, ship, archive — `npm run ci` as final gate; PR; move
      plan doc to `docs/done/`.

## Open questions

- **Does the owner want the admin view at a URL route** (`/#admin`,
  react-router, or `?view=admin`) rather than a toggle inside the app?
  Deferred until they weigh in; the conditional-view approach in step 4
  does not preclude adding routing later.
- **How aggressively should an admin be deletable/disablable?** Managing
  (deleting or locking) other users is not mentioned in the issue — left
  out pending clarification; permission toggles cover the immediate need.
- **"Other things"** besides users are vague; only models are named and
  explicitly deferred. Nothing else planned.
- **Last-admin protection via API only vs. DB-level** — a simple service
  check is planned; a Mongo unique/partial-index scheme seems like
  overkill for a single-owner app.
