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
- `npm run ci` re-verified green on this branch in this pass (2026-09-11,
  commit `7373686` pushed to origin): server 37 tests, client 12 tests,
  lint/format/typecheck/build all clean. CI on PR #19 is also green
  (`ci` + `ci-gate` SUCCESS) and all four pending-review threads from the
  owner are addressed by that commit.
- `docker-compose.live.yml` and `src/client/Dockerfile` still serve the
  frontend via **vite preview** (`CMD ["npm", "run", "preview", ...]`);
  no nginx/static-serving change exists anywhere on the branch.
- `src/client/src/components/AdminView.tsx` contains **zero**
  `className` attributes — no styling pass has happened.

## Not-done directives (verified from repo state, 2026-09-11)

The ticket is **not** finished. Three owner directives from the issue
comments are not yet satisfied in code:

1. **Static frontend / nginx in the live stack** — comment 7: "we're
   currently using Vite Preview - this seems wrong for production
   anyway - front-end should be static - if we need nginx for routing
   that is fine by me! Add it to docker-compose.live.yml :)" Both
   `src/client/Dockerfile` and `docker-compose.live.yml` are untouched.
   ➜ New step 8.
2. **Admin view styling, minimal** — comment (answer to styling
   question): "it would be good to bring it into line stylistically
   with the chat UI but don't go overboard on this, minimal is fine for
   now. Ideally don't duplicate CSS :)" Not done at all.
   ➜ New step 9.
3. **Follow-up ticket for token staleness** — never filed (issue #20 is
   the contracts ticket, not this). ➜ Orchestrator handoff in step 11b.

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
  which of (a)/(b) is chosen; the owner confirmed (b) via answer 7
  below.
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

## Resolved owner decisions, part 2 (later issue comments, 2026-09-11)

7. **Route mechanism confirmed** — the owner accepted the reading that
   the admin view mounts at a real URL (`/admin`) handled inside the
   SPA (approach (b)). The same comment adds the static-frontend
   directive implemented in step 8: vite preview "seems wrong for
   production anyway", nginx is fine, add it to `docker-compose.live.yml`.
8. **Non-admin deep-linking `/admin`** — owner: prefer "not authorized"
   or a 3xx redirect back to `/` with an error growler, "but this can
   be done against another ticket, the silent fallback is fine for
   now" → step 11c files that ticket.
9. **Admin view styling** — owner: bring it in line with the chat UI,
   "minimal is fine for now. Ideally don't duplicate CSS" → step 9.
10. **Non-admins should never see any routes generally** — the
    principle under answer 8; the shipped `Admin` link is already
    `role === 'admin'`-gated, consistent with this principle.

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
      "This account cannot be demoted" for that email. The count-based
      last-admin check originally kept here was REMOVED on the same day
      per an additional directive review comment on PR #19 ("this
      should just be formsatz@gmail.com" — see Rectifications §4); the
      email guard is now the only demotion block.
      Covered by two tests: (a) demoting the owner → 400, (b) demoting
      a sole non-owner admin → 200.

5. ⚠ Rework: **admin view mounting + permission control (resolved
   2 and 6)**. DONE 2026-09-11 (approach (b), owner-confirmed via
   resolved 7):
   a. `App.tsx`: `showAdmin` state removed; exports
   `isAdminRoute()` (`window.location.pathname.startsWith('/admin')`)
   and renders `<AdminView />` plus a `Back to chat` link to `/`
   when an admin is at `/admin`. The admin entry point is a
   `<a href="/admin">Admin</a>` link (full page navigation, so no
   popstate/router code is needed). A non-admin deep-linking
   `/admin` falls back to the chat view (client-side only; the
   API is already `requireRole('admin')`-guarded).
   b. Deployment: `vite preview` empirically serves `/admin` with
   HTTP 200 and the app HTML (SPA fallback is default), so
   `/admin` works today. However the owner's separate directive
   to retire vite preview in favour of a static/nginx frontend
   (comment 7) was NOT part of that check and is unfinished
   deployment work — see step 8.
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
- [ ] 8. ⚠ Outstanding: **static frontend in the live stack (owner
      directive, comment 7)**. Replace vite preview as the production
      frontend server:
      a. Add a Vite build stage or a second Dockerfile stage that
      produces `src/client/dist` and serves it with nginx
      (`nginx` base image, config with `try_files $uri
 /index.html;` for `/admin` SPA fallback).
      b. Update `docker-compose.live.yml`: the `frontend` service uses
      the nginx image and no longer runs vite; no new routing
      behavior needed because the fallback covers `/admin`.
      c. Verify `/` and `/admin` return 200 with the app HTML from the
      nginx container. Concrete wiring detail (verified from code):
      `src/client/src/services/admin.ts` calls same-origin
      `/api/...` and auth is a cookie, so nginx must proxy the API
      rather than the client reaching the backend on another port:
      `location /api/ { proxy_pass http://backend:5000; }` in the
      nginx config keeps it same-origin (this is also what
      `vite.config.ts` warm-up dev proxy does today).
- [ ] 9. ⚠ Outstanding: **minimal AdminView styling (owner directive)**.
      Bring the table/checkbox/buttons in line with the chat UI's
      design tokens; reuse existing CSS classes from the chat
      components and do not duplicate CSS. Acceptance: visually
      consistent with the chat view, no new CSS file.
- [x] 10. Verify — `npm run ci` green on this pass (2026-09-11). Re-run
      after steps 8–9 land.
- [ ] 11. Orchestrator handoff (no code):
      a. Update the stale PR #19 body — it still describes the removed
      in-app toggle and the removed last-admin check.
      b. File the follow-up GitHub ticket for token re-issue/staleness
      (resolved 3) so it does not get lost.
      c. File the follow-up ticket for a "not authorized" page or
      redirect-with-growler at `/admin` for non-admins (see
      resolved 8).
      d. After merge, move this plan to `docs/done/`.

## Known bugs in the current branch

- Fixed 2026-09-11: the duplicated `<ChatWindow />` render in the
  non-admin branch of `App.tsx` (a copy-paste bug) is gone; client
  tests were re-run and stay green.

## Open questions

Verified state: the owner has answered every question previously listed
here (original 1–6 above, plus the later 7–10 on the issue). The four
items formerly open (route mechanism, non-admin panels, non-admin
deep-linking, admin styling) are now resolved owner decisions above or
concrete steps (9, 11c) that no longer depend on an answer.

1. **NEW — static-frontend topology for `/api` behind nginx (feeds step
   8).** The owner approved nginx ("if we need nginx for routing that
   is fine by me"), but did not specify the container topology. Two
   credible designs: (a) nginx as the single front door on port 4173
   serving static files and proxying `/api/` to the backend service
   (cookie auth stays same-origin; the `frontend:15173` port exposure
   ends up replaced); (b) a second nginx that only proxies, leaving the
   express app direct. (a) is the standard pattern and the plan's
   default; it changes the live top-level port mapping, which is why
   this is worth one confirmation before it ships. No other step
   depends on the answer.
