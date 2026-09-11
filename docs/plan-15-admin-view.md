# Plan: #15 Admin view

## Motivation

From [issue #15](https://github.com/alex-moon/tova/issues/15): add a new
`admin` permission that grants access to an admin view where the owner can
manage users (and later other things, e.g. models).

Repo state on branch `feat/tv/15-admin-view` (verified from code, not just
issue comments):

- `src/server/models/User.ts` already has `role: 'user' | 'admin'`
  (enum, default `'user'`) and `permissions: string[]`.
- `src/server/middleware/auth.ts:31` defines `requireRole(...roles)` but
  **nothing uses it** — there is no admin API surface. Routes mounted in
  `src/server/index.ts` are only `/api/auth` and `/api/chat`.
- There is **no frontend router**; `src/client/src/App.tsx` is a single-page
  chat UI switching between `<Login />` and the chat layout based on
  `useAuth()`. No admin UI exists anywhere.
- Prior art: `docs/plan-3-user-permissions.md` — admin is already seeded as
  `formsatz@gmail.com` with `role: 'admin'` and the `routing` permission.
- The issue has **no comments and no answers from the owner**; every
  interpretation of the one-sentence issue body is ours.

So the ticket splits into: (a) an admin-guarded backend API for user
management, and (b) a frontend admin view rendered only for admin users.

## Decisions (with critique)

- **Use the existing `role: 'admin'` + `requireRole` middleware** rather
  than adding a separate `admin` entry to `permissions`. _Critique:_ the
  issue literally says "a new **permission**: admin", so this is an
  interpretation, not a settled requirement (see open question 1). It is
  used because the codebase already treats `role` as the admin marker and
  `permissions` as feature grants (`routing`); the change is cheap to
  reverse — swapping the guard to a permissions check is a one-line edit
  in one middleware, no route rework.
- **No react-router.** The client is a single page with no routing; adding
  the admin view as a conditional view in `App.tsx` mirrors the existing
  login/chat switch. _Critique:_ without a URL, a refresh or shared link
  always lands on chat, and deep-linking can never work. Acceptable for a
  single-owner tool, but see open question 2.
- **Model management is out of scope** — the issue explicitly defers it.
- **No user deletion/disabling** — not mentioned in the issue, and
  deletion touches dependent data (sessions) that this plan does not
  cover. See open question 3.

## Steps

Each step is scoped to a single reviewable commit.

- [ ] 1. Backend: create `src/server/routes/admin.ts` and mount it as
      `app.use('/api/admin', adminRoutes)` in `src/server/index.ts` (after
      the existing mounts, alongside `/api/auth` and `/api/chat`).
      `GET /api/admin/users` returns `bcrypt`-free user projections:
      `id`, `email`, `role`, `permissions`, `hasGoogle` (boolean,
      `googleId != null`), `createdAt`, `updatedAt` — never `passwordHash`
      nor raw `googleId`. Guard: `authenticate` then
      `requireRole('admin')` (403 for non-admins, 401 without a cookie —
      reuse `middleware/auth.ts` as-is).
- [ ] 2. Backend: mutation endpoints in the same `admin.ts` file. - `PUT /api/admin/users/:id/permissions` — body must be a
      `string[]` whose entries are all `routing` (the only permission
      that exists today; reject unknown permission names with 400 so we
      don't invent a grant vocabulary silently). Persist with
      `User.findByIdAndUpdate(id, { permissions: value }, { new: true })`
      and return the same projection as step 1. - `PUT /api/admin/users/:id/role` — body `{ role: 'user' | 'admin' }`;
      before saving an admin→user change, check
      `User.countDocuments({ role: 'admin' })`. If the target is an admin
      and the count is 1, return 400 ("cannot demote the last admin").
      Critique: this is a count-then-write check, not atomic — two
      concurrent demotions could race. With a single human owner this is
      a practical non-issue; do not build a Mongo partial-index scheme
      (noted so a reviewer knows it was considered and rejected).
      Important edge: an admin demoting _themselves_ passes this check
      and is precisely the risky-ish case — it is also the existing
      seeded admin, so resolve intended behavior (open question 5). - Guard both endpoints identically to step 1. Return 404 for
      unknown user ids (validate before treating cast errors as 500s:
      check the ObjectId shape or catch CastError).
- [ ] 3. Backend: expose live role + permissions on `GET /api/auth/me`.
      Today `/me` re-derives everything from the JWT, and role changes
      made in step 2 would not be visible until token expiry (7 days).
      Rewrite `/me` to look the user up in the DB (`User.findById`) and
      return `{ id, email, role, permissions }`; 401 if the user has been
      deleted. Keep `authenticate`/`requireRole` reading the _token_ role
      for existing routes (data available is stale but cannot newly
      escalate); the staleness window for admin access is flagged in
      open question 4 rather than silently accepted.
- [ ] 4. Frontend: create `src/client/src/components/AdminView.tsx` and
      render it conditionally from `App.tsx` for `user.role === 'admin'`
      with a small toggle/button (same conditional-render pattern as the
      `user ? chat : Login` switch). Contents: user table (email, role,
      `hasGoogle`, permission badges, timestamps), per-row actions to
      grant/revoke `routing` and toggle admin. Data via `axios` using the
      same `credentials`/cookie pattern the chat and session code already
      uses (`axios` defaults already include cookies in this app). Show
      API errors inline (e.g. 400 for last-admin protection). Note
      `useAuth`'s user object comes from `/api/auth/me`, which step 3
      upgrades — non-admins simply never see the toggle.
- [ ] 5. Tests. - Server (Jest + supertest, pattern from
      `src/server/routes/chat.permissions.test.ts` — mock what must be
      mocked, real Mongo through the existing test Mongo setup used by
      that suite): 401 unauthenticated, 403 non-admin on all three
      endpoints; 200 list for admin with `passwordHash` absent;
      permission body validation (unknown permission → 400, valid →
      persisted); role toggle both directions; last-admin demotion →
      400; unknown id → 404. - Client (Vitest, pattern from `src/client/src/App.test.tsx`): admin
      menu/button hidden for `role === 'user'`, shown for
      `role === 'admin'`; AdminView renders rows and calls the API on
      toggle actions.
- [ ] 6. Verify, ship, archive — `npm run lint`, `npm run typecheck`,
      `npm test`, `npm --prefix src/client run lint`, client format check,
      then `npm run ci` as the final gate. PR; after merge move the plan
      doc to `docs/done/`.

## Open questions

No answers exist in the issue comments (the issue has none), so no
question can be answered from the issue. Every blocker-free assumption
above is explicitly critiqued in "Decisions". None of steps 1–6 depends
on an unresolved question; each question only changes shape, not
feasibility, and has a stated default.

1. **Role vs. permission semantics** — should `admin` be a
   `permissions[]` entry instead of the existing `role`? The codebase
   currently encodes admin in `role`. Default in this plan: `role`.
   Fallback if owner insists: guard via `permissions.includes('admin')`.
2. **URL-routed admin view?** (`/#admin`, react-router) vs. the planned
   in-app toggle. Planned default: toggle; adding routing later is
   non-breaking.
3. **Should admins ever be deletable/disablable?** Not mentioned in the
   issue; out of scope here regardless of answer (touches sessions
   cascade).
4. **Stale admin access window** — because `authenticate`/`requireRole`
   read the 7-day JWT, a demoted admin keeps working API access up to
   token expiry, and a promoted user needs a re-login (step 3 fixes
   `/me` visibility but not `requireRole`). Is re-issuing/shortening
   tokens required, or is this acceptable for a single-owner app?
   Planned default: accept with `/me` reflecting live role.
5. **Admin demoting themselves** — permitted by the current count-based
   check as long as another admin remains; but today only one admin is
   seeded, so self-demotion is refused until a second admin exists.
   Confirm intended behavior; default: allow only when another admin
   exists (covered by the count check).
6. **Permission names beyond `routing`** — should step 2 accept arbitrary
   permission strings (paying forward for future grants), or validate
   against the known set? Planned default: reject unknown strings.
