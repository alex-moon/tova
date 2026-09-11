# Plan: #15 Admin view

## Motivation

From [issue #15](https://github.com/alex-moon/tova/issues/15): add a way for
the owner to manage users (and later other things, e.g. models) from an
admin view.

Repo state on branch `feat/tv/15-admin-view` (verified from code, not just
issue comments):

- `src/server/models/User.ts` has `role: 'user' | 'admin'` (enum, default
  `'user'`) and `permissions: string[]`.
- `src/server/middleware/auth.ts:31` defines `requireRole(...roles)`;
  nothing used it until this branch.
- `src/server/routes/admin.ts` now exists on this branch with
  `GET /users`, `PUT /users/:id/permissions`, `PUT /users/:id/role`,
  all guarded by `authenticate` + `requireRole('admin')`, mounted via
  `/api/admin` in `src/server/index.ts`.
- `src/server/routes/auth.ts` `/me` now returns live `{ id, email, role,
permissions }` from the DB instead of re-deriving from the JWT.
- `src/client/src/components/AdminView.tsx` exists and is rendered in
  `App.tsx` behind an in-app `showAdmin` toggle button for
  `user.role === 'admin'`.
- Server tests in `src/server/routes/admin.test.ts` and client tests
  cover auth guards, validation, last-admin demotion, 404s.
- Prior owner-decision context: `docs/plan-3-user-permissions.md` —
  admin seeded as `formsatz@gmail.com`, `role: 'admin'`,
  `permissions: ['routing']`.
- `npm run ci` reported green in an earlier pass on this branch (commit
  `72c3d5c`, 2026-09-11); re-verify before shipping.

## Resolved owner decisions (from issue #15 comments, 2026-09-11)

These were once plan "open questions"; the owner has answered all six.
They are now requirements, several of which the current implementation
does **not** yet satisfy:

1. **Role semantics** — key on `role`, not `permissions`. Matches what
   was implemented (`requireRole('admin')`); no change needed.
2. **Navigation** — the owner does **not** want the in-app toggle the
   branch currently implements. Verbatim intent: panels around the chat
   view for non-admins are fine, but for admins the admin view "should
   be almost like a whole separate app", leaning toward **native HTTP
   routes** ("start there and we can migrate later"). The owner asks us
   to check how frontend routes are handled today and to update docker
   compose and vite configs as needed.
   ➜ Requires rework of the step-4 UI mounting (see step 5) and a
   clarifying question (open question 1). The owner said "I could be
   convinced otherwise", so the exact mechanism is not fully pinned
   down — the plan structurally avoids depending on the answer by
   isolating all routing/config changes in one step.
3. **Token staleness** (demoted admin keeps up-to-7-day working API
   access) — accepted for now; revisit on a separate ticket. Matches the
   implemented default. Do not do token re-issue work here; it must be
   tracked as a GitHub issue when this ticket closes.
4. **Self-demotion / protected owner account** — `formsatz@gmail.com`
   cannot be demoted **at all** (email-based hard guard, regardless of
   how many other admins exist). This is NOT implemented: the current
   code only has the count-based "last admin" check.
   ➜ Requires rework (see step 5).
5. Permission-name handling — validate against a known in-app set (the
   "ditto" reinforces formsatz@gmail.com handling). Matches what was
   implemented (`KNOWN_PERMISSIONS`); no change needed.
6. **Permission UI** — draw a dropdown/checkbox-style control for
   permissions; do **not** enforce at the database level. The current
   implementation uses a plain button toggle; visually adequate but the
   owner asked for a dropdown/checkbox control.
   ➜ Minor rework (see step 5), folded into the same UI pass.

## Decisions (with critique)

- **`role: 'admin'` + `requireRole` guard** — owner-confirmed (resolved
  1). No doubt left; the fallback (guarding on
  `permissions.includes('admin')`) is dead.
- **Email-based protection for `formsatz@gmail.com`** — owner-confirmed
  (resolved 4): demotion must be refused with 400 for that specific
  email even if other admins exist. _Critique:_ hardcoding an email in
  application code is brittle (what if the owner's identity provider
  account changes?), and the protected account becomes a lynchpin: it
  can only be re-sited by editing code. Accept for now because the
  owner explicitly chose it; a config/env value instead of a literal
  would be the cheap future escape hatch — but do not build that
  without a request (only one admin exists).
- **Count-based last-admin check stays alongside the email guard** —
  the email guard is the owner's chosen blanket rule; the count check
  still protects every other admin from demoting the last one. Keep
  both. _Critique (accepted previously, still true):_ the check is
  count-then-write, not atomic — two concurrent demotions could race;
  with a single human owner this is a practical non-issue. A Mongo
  partial-index scheme was considered and rejected.
- **Admin view as "almost a separate app" at a real URL** —
  owner-confirmed direction (resolved 2). _Critique:_ "native HTTP
  routes" is ambiguous for this stack: the client is a Vite SPA whose
  only express-served artifact is a single `index.html`
  (`src/server/index.ts:41` serves `src/client/dist`; the live stack
  serves the build through `vite preview`, per `src/client/Dockerfile`
  and `vite.config.ts` `preview.allowedHosts`). Genuinely different
  mechanisms exist — (a) a second Vite entry HTML (`/admin.html` →
  `/admin`) rendered by the same react app, (b) a `/admin` route inside
  the SPA via URL parsing + history API (no react-router dependency),
  (c) an express-served server-rendered page. (a) and (b) are close
  cousins (static, cookie-authenticated, `vite preview` compatible);
  (c) is a real architectural departure. Only (a)/(b) fit "almost a
  whole separate app" without replacing the deployment story; the swing
  factor is answered in open question 1 and no later step depends on
  which of (a)/(b) is chosen.
- **Non-admin "panels around the chat view"** — owner mentioned these,
  but nothing in this ticket defines what they are. Deliberately out of
  scope (open question 2); this ticket's non-admin-visible change stays
  the removal of the admin toggle button.
- **No react-router dependency** — maintained: the client has no
  router, and for approach (b) hand-rolled URL handling for two paths
  is smaller than introducing a dependency. Revisit only if the admin
  app grows nav of its own.
- **Model management out of scope** — issue explicitly defers it.
- **No user deletion/disabling** — not raised by the owner; deletion
  touches dependent sessions data. If wanted, it belongs on its own
  ticket, not a plan amendment.
- **Token staleness accepted** — owner-confirmed (resolved 3). The
  implemented behavior (API reads role from 7-day JWT; `/me` reflects
  live DB role) is the end state for this ticket. Only follow-up is the
  separate-ticket note in step 6.

## Steps

Status is honest per step. Steps 1–3 + 7 (verification) are implemented
and consistent with owner answers. Steps 4–5 are rework required by
owner answers 2 and 4/6 that landed **after** the original
implementation. Step 6-M remains a known bug found during this revison.

- [x] 1. Backend admin list API: `src/server/routes/admin.ts` serving
      `GET /api/admin/users` with the bcrypt-free projection (`id`,
      `email`, `role`, `permissions`, `hasGoogle`, `createdAt`,
      `updatedAt`; never `passwordHash`/`googleId`), guarded by
      `authenticate` + `requireRole('admin')`. Implemented.
- [x] 2. Backend mutation endpoints in the same file:
      `PUT /users/:id/permissions` (validated against
      `KNOWN_PERMISSIONS = ['routing']`, unknown strings → 400; whole
      array replaces) and `PUT /users/:id/role` with the
      count-based "cannot demote the last admin" 400. ObjectId-shaped
      bad ids map to 404 rather than CastError 500s. Implemented.
- [x] 3. `GET /api/auth/me` rewritten to look the user up in the DB and
      return live `{ id, email, role, permissions }`; 401 if deleted.
      Implemented. (Note: this makes newly granted `role`/permissions
      visible but does not fix `requireRole` reading the stale token —
      owner-accepted, see resolved 3 / follow-up in step 6.)
- [ ] 4. ⚠ Rework: **protected owner account (resolved 4)**. In
      `src/server/routes/admin.ts`, before role demotion of any admin,
      refuse with 400 when `user.email === 'formsatz@gmail.com'`
      (blanket rule; the count-based last-admin check stays for all
      other admins). Update `admin.test.ts`: (a) demoting
      `formsatz@gmail.com` → 400 even when a second admin exists; (b)
      demoting a second admin still allowed while formsatz remains
      admin. Express the email as a module-level constant in
      `admin.ts` (not inline in the route handler) so the future
      config-ification is a one-line move.
- [ ] 5. ⚠ Rework: **admin view mounting + permission control (resolved
      2 and 6)**. Current state: in-app toggle in `App.tsx` +
      `AdminView` with a button-based toggle per permission — both
      diverge from owner answers. Concrete rework:
      a. Replace the `showAdmin` toggle with URL-based mounting, per
      open question 1 default (approach (b): no dependency, no
      server change): in the admin app view, render
      `<AdminView />` when `window.location.pathname.startsWith('/admin')`,
      chat otherwise; admin toggle becomes a
      `window.location.assign('/admin')` link, chat access becomes a
      link back to `/`. Cleanup: while touching this, delete the
      duplicated `<ChatWindow/>` render (`App.tsx:257-262`) — a
      plausible copy-paste bug that also breaks the `main` layout
      when admin view replaced one of the two panes.
      b. Deployment check the owner explicitly asked for: the admin
      view lives behind `/admin` **on the frontend server**, i.e.
      `src/client/vite.config.ts` `preview` must allow the path to
      fall back to `index.html` for `/admin` (SPA fallback is
      default in vite preview; verify, don't assume — add an
      `npm --prefix src/client run build && vite preview` smoke check
      that `/admin` serves the app). Both compose files
      (`docker-compose.live.yml` frontend, `docker-compose.local.yml`)
      keep their current single frontend container; docker compose
      only needs changes if verification shows the SPA fallback
      breaks — note the finding either way in the PR.
      c. Permission control in `AdminView.tsx`: a per-user checkbox
      (single permission today → checkbox is the cheapest UI that
      satisfies "drop-down or checkboxes") writing the full
      permissions array via the existing PUT endpoint. Server-side
      validation already rejects unknown strings (resolved 6); no
      database-level enforcement (per owner).
      d. Update client tests (`App.test.tsx`, AdminView tests) for the
      URL mounting and checkbox control.
- [ ] 6. Tests for step 4's email-protection behavior (in addition to
      existing suites, which are green as of commit `72c3d5c`).
- [ ] 7. Verify, ship, archive — run `npm run lint`, `npm run
typecheck`, `npm test`,
      `npm --prefix src/client run lint` + format check + tests, then
      `npm run ci` as the final gate (re-run even though it was green
      at `72c3d5c`, because steps 4–6 change code). Open/refresh the
      PR with a note listing the owner-answer rework items; after
      merge move this plan to `docs/done/`. Before closing, file the
      follow-up GitHub ticket for token re-issue/staleness (resolved 3) so it does not get lost.

## Known bugs in the current branch

- `src/client/src/App.tsx:251-262`: `<ChatWindow />` is rendered twice
  in the non-admin branch. Unintended (the plan's original step 4
  rendered it once); fix as part of step 5a. Note: a fix here is expected
  to keep existing client tests green — they were written against this
  state and should be re-checked after the fix.

## Open questions

Verified state: the owner answered all six original questions in the
issue comments (2026-09-11), so those are requirements above. Nothing in
steps 4–7 depends on either remaining question; each has a default the
plan proceeds with, and each touches only the shape of step 5.

1. **What does "native HTTP routes" concretely mean for the admin
   view?** Read literally, an express-served server-rendered page
   (approach (c) in Decisions) would be the most "native HTTP" reading,
   but that departs from the SPA and forces deployment rework. The plan
   defaults to approach (b) — real URLs (`/admin`, `/`) handled in the
   SPA with hand-rolled routing, no react-router, no server change —
   because it satisfies "separate app at a URL it can be reached at,
   refreshable, deep-linkable" without a build-stack change. If the
   owner wants a truly separate HTML entry (approach (a), Vite
   multi-page), that is additive and cheap. If they meant server-side
   rendering, that is a bigger ticket.
2. **"Panels around the chat view for non-admins"** — what belongs in
   these panels? Nothing in the issue body (one sentence) or this
   ticket's scope defines them; the ticket's backend surface is
   admin-guarded so nothing ships yet that would need them. The plan
   excludes them. If they are meant to be shared-UI chrome (e.g. an
   account info panel), they likely belong in a separate ticket too.
