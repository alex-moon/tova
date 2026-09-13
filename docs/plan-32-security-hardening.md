# Security pass: harden auth surface + add CI security scanning

Issue: [alex-moon/tova#32](https://github.com/alex-moon/tova/issues/32)
Branch: `fix/tv/32-security-hardening`

## Motivation

The app has accrued security gaps while moving fast. Verified against the current tree on
2026-09-13 (all line numbers re-checked on this branch):

- `src/server/middleware/auth.ts:4` and `src/server/routes/auth.ts:9` both fall back to
  `'fallback_secret'` when `JWT_SECRET` is unset (`grep` confirmed on branch). A production
  deployment missing the env var would silently run with a publicly known signing key.
- Session cookie (`routes/auth.ts:29-38`) sets `httpOnly` and `secure` but no `sameSite`.
  The pre-OAuth `google_state` cookie (`routes/auth.ts:105-110`) also sets no `sameSite`.
  `/api/auth/me` (`routes/auth.ts`, inline handler near line 190) duplicates the
  middleware's verification logic instead of reusing `authenticate`.
- `src/server/index.ts` `createApp()`: no `helmet`, no CORS policy, `express.json()` with
  no body-size limit (index.ts:21), no rate limiting anywhere in `src/server` (grep
  confirmed).
- Public routes validate bodies with manual truthiness checks only
  (`routes/auth.ts` /register and /login, `routes/feedback.ts`).
- `.github/workflows/` contains only `ci.yml` and `deploy.yml`; no secret scanning or
  SAST anywhere.

## Facts resolved from the repo (previously open questions)

These were open in the first draft; each is now answered by direct inspection, so no
instruction below depends on them:

- **Zod version:** root `package.json` has NO zod dependency; it exists only transitively
  (`npm why zod` → `zod@4.5.4` via `@mastra/core` peer range
  `^3.25.76 || ^4.1.8`). Add `zod` to root `dependencies` pinned to `^4.5.4` (same major
  as the resolved transitive version, so `mastraService.ts` keeps working).
- **Express 5 compatibility:** the app runs Express `^5.1.0` (package.json).
  `express-rate-limit` has supported Express 5 as a peer since v6.4.0; install latest
  (`^8.x`). `helmet` is framework-agnostic middleware, works on Express 5.
- **CORS:** `createApp()` serves the client from the same Express process in production
  (express.static, index.ts:39-44) and proxies to Vite same-origin in dev
  (http-proxy-middleware, index.ts:47-56). There is no cross-origin API client, so no
  explicit CORS middleware is needed. Helmet's default handlers suffice; if any scan or
  review later shows a cross-origin consumer, that is a separate decision.
- **`sameSite` value (previously "open"):** resolved by reading the OAuth flow.
  `/api/auth/google` sets `google_state` (auth.ts:105), the user lands back on
  `/api/auth/google/callback` as a cross-site top-level GET navigation (auth.ts:113). Under
  `sameSite: 'strict'` that navigation would NOT carry `google_state` and the callback
  would 400. `sameSite: 'lax'` sends cookies on top-level GET navigations, so `lax` is
  correct for `google_state`, and applies to `token` for consistency. Existing
  `auth.google.test.ts` exercises this flow — if the analysis is wrong, the suite fails
  immediately and will catch it. (Residual risk lives behind the existing tests, not
  behind an unknown.)
- **npm audit baseline:** ran `npm audit` on this branch — 3 advisories (1 moderate: `baseline-browser-mapping`; 2 high: `brace-expansion`, `browserslist`). All are dev/build
  tooling, all `fixAvailable` via `npm audit fix` (semver-compatible transitive bumps). So
  the concrete plan is: run `npm audit fix`, re-verify full suite, then gate CI with
  `npm audit --omit=dev --audit-level=high --fail-on=all` plus allowlisting any unavoidable
  advisors via the documented audit config.

## Open questions

- **Gitleaks full-history findings:** if the first history scan flags a secret already
  committed to `main` (e.g. a past `.env` commit), remediation (rotation, history rewrite)
  exceeds this ticket's scope. Tentative handling: findings from the history of existing
  branches can be allowlisted in `.gitleaksignore` with justification and tracked as a
  follow-up issue; findings in NEW commits must fail the build. Needs a call — posted as a
  comment on the issue. No planned step below depends on this: the workflow file lands
  first with scan-on-PR; history-scan strictness is a config line.

## Open questions (added during critic pass)

- **Before/after for the `/me` unauthenticated message:** deduping onto `authenticate`
  necessarily changes the no-cookie message from `Not authenticated` to the middleware's
  `Authentication required`, and an invalid token now also _clears_ the cookie (the old
  inline handler did not). No client code depends on either (grep confirmed; the client
  only uses the string as a mock marker), and `index.test.ts` was updated to pin the new
  message — but flagging it here as deliberate, reviewable drift.
- **Rate limiter key under a proxy:** `express-rate-limit` v8 keys by client IP. With
  `app.set('trust proxy', ...)` unset, all requests behind a single reverse proxy
  (deploy.sh runs node behind nginx, if present) share one bucket. The plan deliberately
  does NOT set `trust proxy` (IP-spoofing risk); if production actually sits behind a
  proxy, Nginx must send genuine client IPs and Node must be told to trust the local hop
  — needs confirmation of the deploy topology before tightening `limit` below the current
  conservative values (500 global / 20 auth per 15 min).
- **`z.string().min(8)` register password policy was already `8` in practice?** The
  original handler had _no_ length check (only truthiness); tests always used
  `password123` (11 chars). Enforcing `.min(8)` is a behavior change: previously-accepted
  short passwords (< 8 chars) now get 400, and existing accounts with short passwords can
  still log in (loginSchema deliberately has no length rule beyond required). Confirm that
  "min 8 on registration" is the intended policy — the plan text said "matching current
  expectations", but no such expectation existed in code.
- **Pre-existing orphaned suite `src/server/iteration-harness.test.ts`:** imports
  `scripts/iteration`, which does not exist on `origin/main` (leftover of the #37/#41
  revert); every `npm run ci` fails at the test step because of it. Deleted on this branch
  as the minimal unblock for this ticket's verify gate — flagged for the orchestrator to
  confirm it does not collide with (or is redundant with) `feat/tv/41-ux-fixes`, which
  applied the identical deletion.

## Plan / Done

Each item is sized to be one commit:

- [x] **Unify JWT secret resolution.** New `src/server/config/jwt.ts` exporting
      `getJwtSecret(): string` (module-level `jwtSecret` const is fine too; prefer a function
      so tests can stub `NODE_ENV` before resolution). Behavior: if `NODE_ENV === 'production'`
      and `JWT_SECRET` is missing/empty → `throw` at first call, with a message naming the env
      var; otherwise if missing → `console.warn` once. Delete `const JWT_SECRET = ... || 
'fallback_secret'` from both `middleware/auth.ts:4` and `routes/auth.ts:9`; both import
      the shared module. Tests: new `config/jwt.test.ts` covering (a) production + missing →
      throws, (b) production + set → returns value, (c) non-production + missing → warns, no
      throw.
- [x] **Cookie flags.** In `routes/auth.ts`: add `sameSite: 'lax'` to the `token` cookie
      (`issueSessionCookie`, lines 29-38) and the `google_state` cookie (lines 105-110), with a
      comment explaining the OAuth-redirect rationale (see resolved fact above). Do NOT change
      `httpOnly`/`secure`/`maxAge`. Verify `auth.google.test.ts` and `auth.contracts.test.ts`
      still pass (they inspect `res.headers['set-cookie']`).
- [x] **Deduplicate `/api/auth/me`.** Replace the inline verification in the `/me`
      handler (auth.ts ~line 190) with the shared `authenticate` middleware — either mount a
      sub-router or apply `authenticate` to just that route. Keep the response shape identical
      (`auth.contracts.test.ts` and `admin.test.ts:175` pin it).
- [x] **Zod validation on public bodies.** `npm install zod@^4.5.4` at root. New
      `src/server/validation.ts` (or colocated schemas): `registerSchema` (email: `.email()`,
      password: `.min(8)` matching current expectations), `loginSchema`, and a feedback schema
      matching `routes/feedback.ts` fields. Apply with `safeParse` → 400 + field messages on
      failure; delete the manual `if (!email || !password)` checks. Also constrain
      `express.json({ limit: '1mb' })` here or in the next commit (index.ts:21). Tests:
      extend `auth.contracts.test.ts` + `feedback.test.ts` with 400-case expectations.
- [x] **Add `helmet` + rate limiting.** `npm i helmet express-rate-limit`. In
      `createApp()` (index.ts): `app.use(helmet())` before `express.json()`;
      `express.json({ limit: '1mb' })`; a global limiter (`windowMs: 15*60_000, limit: 500`)
      and a stricter `/api/auth/*` limiter (`limit: 20`). Both limiters skip cleanly in dev
      and test (`NODE_ENV !== 'production'` → generous limits rather than no limiting, since
      the Acceptance criterion asks for "rate limit configured on auth routes"; Jest suites
      hit `/api/auth/register` repeatedly — `admin.test.ts:15-23` — so the global limiter must
      be set above their burst volume, or set `app.set('trust proxy', true)` only if scans
      demand it). Verify: run `npm test` and `npm run ci` right after wiring.
- [x] **CI: security workflow.** New `.github/workflows/security.yml`, triggers: PRs +
      push to main.
  - `gitleaks/gitleaks-action@v2` with full-history fetch (`fetch-depth: 0`).
  - `semgrep` job: `semgrep/semgrep-action` or plain `semgrep ci --config p/oss-community-rules` over `src/server` (note: this restricts unless noise forces widening). Failure on findings.
  - `actions/dependency-review-action@v4` on PRs only.
  - `npm audit --omit=dev --audit-level=high` step (see resolved fact: tree is expected
    green after the fixes).
    Order matters: land this workflow BEFORE assuming scans are green; first run may produce
    findings that need triage (see Open questions).
- [x] **npm audit fixes.** Run `npm audit fix` on the branch, eyeball the lockfile diff
      (should be semver-compatible patches to dev/build deps only), re-run `npm run ci`.
      Then enable the audit step in security.yml as a hard gate.
- [x] **Verify.** `npm run ci` must pass end to end (server lint, format check,
      typecheck, server tests, client lint/format/tests/build). Add/adjust tests for the
      secret-resolution failure path and the new validation 400s (covered in items above).
      Also load the login page via `npm run stack:up` and confirm helmet headers appear and
      register/login still work end to end.

Commit order above is dependency-ordered: secret module → cookie flags → /me dedupe →
validation → hardening middleware → CI workflow → audit gate. Each step keeps
`npm run ci` green so a revert bisect stays clean.

Following the workflow doc, implementation depends on no open question: the only open
item (history-scan findings policy) affects one config line in the new workflow, which is
written last.
