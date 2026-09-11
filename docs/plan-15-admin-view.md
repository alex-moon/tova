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
- **Count-based last-admin check REMOVED (see PR #19 rectifications)** —
  originally kept alongside the email guard; the owner's pending review on
  PR #19 explicitly replaced it ("this should just be formsatz@gmail.com").
  _Critique (accepted, still true then):_ the check was count-then-write,
  not atomic; with a single human owner this was a practical non-issue.
  Removal makes the race moot.
- **Count check was count-then-write, non-atomic** — historical note kept
  for context: a Mongo partial-index scheme was considered and rejected.
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

## Rectifications from the pending review on PR #19 (2026-09-11)

The owner's pending review on PR #19 adds four directive comments (see
the "rectify please" note in the #15 comments). All four implemented in
this pass:

1. **`.gitignore` the `logs/` directory** — added; tracked log files
   must be untracked once (`git rm -r --cached logs`) by whoever commits.
2. **Shared client/server interfaces** — the `AdminUser` contract now
   lives in `src/client/src/types/admin.ts`; a real shared server↔client
   contract package is filed as a follow-up GitHub ticket (the owner
   explicitly allowed the ticket option as non-trivial).
3. **API calls split into a connector service** — new
   `src/client/src/services/admin.ts` (`AdminService` +
   `getErrorMessage`); `AdminView` no longer imports axios; client tests
   mock the service.
4. **Demotion protection = protected owner only** — the count-based
   "last admin" check was removed (owner: "this should just be
   formsatz@gmail.com"); `PROTECTED_OWNER_EMAIL` is the only demotion
   guard. A superadmin tier is the alternative design if the owner
   revisits. Server tests updated: demoting a sole non-owner admin is
   now allowed (200), owner demotion stays 400.

## Steps

Status is honest per step. All steps are implemented and consistent
with owner answers as of this pass (2026-09-11), including the rework
required by owner answers 2, 4, and 6 that landed after the original
implementation.

- [x] 1. Backend admin list API: `src/server/routes/admin.ts` serving
      `GET /api/admin/users` with the bcrypt-free projection (`id`,
      `email`, `role`, `permissions`, `hasGoogle`, `createdAt`,
      `updatedAt`; never `passwordHash`/`googleId`), guarded by
      `authenticate` + `requireRole('admin')`. Implemented.
- [x] 2. Backend mutation endpoints in the same file:
      `PUT /users/:id/permissions` (validated against
      `KNOWN_PERMISSIONS = ['routing']`, unknown strings → 400; whole
      array replaces) and `PUT /users/:id/role`. Originally also a
      count-based "cannot demote the last admin" 400; that check was
      REMOVED on 2026-09-11 per the owner's PR #19 review (see
      "Rectifications" — the email guard is the only demotion block).
      ObjectId-shaped bad ids map to 404 rather than CastError 500s.
- [x] 3. `GET /api/auth/me` rewritten to look the user up in the DB and
      return live `{ id, email, role, permissions }`; 401 if deleted.
      Implemented. (Note: this makes newly granted `role`/permissions
      visible but does not fix `requireRole` reading the stale token —
      owner-accepted, see resolved 3 / follow-up in step 6.)
- [x] 4. ⚠ Rework: **protected owner account (resolved 4)**. DONE 2026-09-11:
      `src/server/routes/admin.ts` exports
      `PROTECTED_OWNER_EMAIL = 'formsatz@gmail.com'` as a module-level
      constant; the role route returns 400
      "This account cannot be demoted" for that email before the
      count-based last-admin check, which stays for all other admins.
      Covered by two new tests: (a) demoting the owner → 400 even with a
      second admin present, (b) demoting a second admin is still allowed
      while the owner stays admin.
- [x] 5. ⚠ Rework: **admin view mounting + permission control (resolved
      2 and 6)**. DONE 2026-09-11 (approach (b), open question 1 default):
      a. `App.tsx`: `showAdmin` state removed; exports
      `isAdminRoute()` (`window.location.pathname.startsWith('/admin')`)
      and renders `<AdminView />` plus a `Back to chat` link to `/`
      when an admin is at `/admin`. The admin entry point is a
      `<a href="/admin">Admin</a>` link (full page navigation, so no
      popstate/router code is needed). A non-admin deep-linking
      `/admin` falls back to the chat view (client-side only; the
      API is already `requireRole('admin')`-guarded).
      b. Deployment check the owner explicitly asked for: verified
      empirically — `vite preview` serves `/admin` with HTTP 200 and
      the app HTML (SPA fallback is default). No compose or vite
      config change needed; noted in the PR.
      c. Permission control in `AdminView.tsx`: per-user checkbox
      (`data-testid="perm-routing-<email>"`) writing the full
      permissions array via the existing PUT endpoint. Server-side
      validation already rejects unknown strings (resolved 6); no
      database-level enforcement (per owner).
      d. Client tests updated: App tests now exercise `/admin` URL
      mounting (admin sees AdminView + back link; non-admin falls
      back to chat; non-admins/`/` hide the Admin link);
      `AdminView.test.tsx` covers checkbox on→off and off→on array
      replaces.
- [x] 6. Tests for step 4's email-protection behavior (see step 4).
- [x] 7. Verify — `npm run lint`, `typecheck`, `test`,
      `npm --prefix src/client run lint`/format/`test`, and
      `npm run ci` all green after this pass; format check clean.
      Remaining in step 7 (for the orchestrator): open/refresh the PR
      with a note listing the owner-answer rework items; after merge
      move this plan to `docs/done/`. Before closing, file the
      follow-up GitHub ticket for token re-issue/staleness (resolved 3)
      so it does not get lost.

## Known bugs in the current branch

- Fixed 2026-09-11: the duplicated `<ChatWindow />` render in the
  non-admin branch of `App.tsx` (a copy-paste bug) is gone; client
  tests were re-run and stay green.

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
3. **Non-admin at `/admin` gets the chat view silently.** With approach
   (b), deep-linking `/admin` as a non-admin silently renders the chat
   app (the admin API itself is still `requireRole('admin')`-guarded).
   Alternative: an explicit "not authorized" page. Default in the
   shipped code: silent fallback to chat. If a redirect/explicit denial
   is preferred, it is a few lines in `App.tsx`.
4. **Admin view styling.** `AdminView.tsx` is functional but bare
   (table, checkbox, buttons, unstyled) relative to the chat UI's
   design tokens. The owner called it "almost a whole separate app";
   whether it deserves a full visual pass is out of scope for this
   ticket's rework and is tracked here as a styling follow-up.
