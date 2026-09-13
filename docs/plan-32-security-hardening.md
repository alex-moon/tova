# Security pass: harden auth surface + add CI security scanning

Issue: [alex-moon/tova#32](https://github.com/alex-moon/tova/issues/32)
Branch: `fix/tv/32-security-hardening`

## Motivation

The app has accrued security gaps while moving fast (verified against the current tree on
2026-09-13):

- `src/server/middleware/auth.ts:4` and `src/server/routes/auth.ts:9` both fall back to
  `'fallback_secret'` when `JWT_SECRET` is unset. A production deployment missing the env
  var would silently run with a publicly known signing key.
- The session cookie (`routes/auth.ts:29-38`) sets `httpOnly` and `secure` but no
  `sameSite`. Logout and the inline `/api/auth/me` handler (auth.ts:190) verify tokens
  out of band; `/me` duplicates the middleware's verification logic instead of reusing
  `authenticate`.
- No `helmet`, no CORS policy, no body-size limit on `express.json()`, and no rate
  limiting anywhere in `src/server` (verified by grep).
- Public routes validate request bodies with manual truthiness checks only.
- `.github/workflows/` contains only `ci.yml` and `deploy.yml`; no secret scanning or
  SAST anywhere.

## Decisions so far

- **Dependency reality check:** the issue says zod is "already a dependency". It is
  present in the tree but only transitively (used directly by
  `src/server/services/mastraService.ts`; declared in
  `src/client/package-lock.json`, not root `package.json`). We will add it to root
  `dependencies` explicitly.
- **`helmet` and `express-rate-limit` are not installed** and will need to be added.
- `JWT_SECRET` is set in the local `.env` and empty in `.env.example`, so failing on a
  missing secret in production must not break local/test/dev boot.

## Plan / Done

Each item is sized to be one commit:

- [ ] **Unify JWT secret resolution.** New `src/server/config/jwt.ts` exporting a
  `jwtSecret` (or `getJwtSecret()`); both `middleware/auth.ts` and `routes/auth.ts`
  import it. Behavior: throw at startup (module load) if `NODE_ENV === 'production'` and
  the var is missing/empty; warn loudly in non-production. Remove both `||` fallbacks.
- [ ] **Cookie flags.** `sessionHttpOnly`/`secure` stay; add `sameSite: 'lax'`
  (Google OAuth redirect is cross-site → `strict` would break the OAuth callback; lax
  keeps the cookie on the redirect response. Document the reason in a comment).
- [ ] **Deduplicate `/api/auth/me`.** Route handler verifies tokens inline
  (`routes/auth.ts:190`); move it onto the shared `authenticate` middleware.
- [ ] **Zod validation on public bodies.** Schemas for `/register`, `/login`, and the
  feedback route(s); replace manual `if (!email || !password)` checks with `safeParse`
  returning 400.
- [ ] **Add `helmet` + body limit + rate limiting.** `helmet()` at app boot,
  `express.json({ limit: '1mb' })`, `express-rate-limit` globally (lenient) with a
  stricter `/api/auth/*` limiter. Decide whether limits live only in prod or everywhere
  when implementing — see Open questions.
- [ ] **CI: security workflow.** `.github/workflows/security.yml`: gitleaks on repo +
  history, semgrep with the OSS community ruleset over `src/`, and
  `actions/dependency-review-action` on PRs. Run on every PR + push to main.
- [ ] **`npm audit` gating.** Either fix existing advisories or allowlist with
  justification before gating the build; do not gate until the tree is green. (Optional
  first pass per the issue.)
- [ ] **Verify.** `npm run ci` must pass end to end after all wiring; add/adjust tests
  for the secret-resolution failure path and new validation errors.

## Open questions

- **Zod as a root dependency** — currently transitive only. Adding it to root
  `package.json` seems uncontroversial, but confirm the version target (v4 is in
  mastra's range; `mastraService.ts` imports work today).
- **Rate limiting in dev/test:** strict limits on `/api/auth/*` may break existing Jest
  tests, which hit auth endpoints repeatedly. Options: disable the limiter when
  `NODE_ENV === 'test'`, set generous limits, or expose via `app.set('trust proxy')`-free
  env-driven config. Will resolve during implementation; the failing-startup behavior is
  the priority.
- **`sameSite: 'lax'` vs `'strict'`:** leaning `lax` because Google OAuth redirects land
  cross-site, but must confirm how the callback actually sets the cookie before locking
  this in.
- **npm audit gating** depends on what advisories currently exist; cannot be planned
  concretely (gate vs allowlist vs fix) until the first audit run on this branch.
- **CORS configuration:** the app serves the client via proxy
  (`http-proxy-middleware`); confirm whether a same-origin setup needs any CORS config
  at all before adding (possibly none — helmet alone may suffice).

Following the workflow doc, implementation avoids depending on any open question: the
secret/config module, cookie flags, `/me` dedupe, zod validation, and the gitleaks +
semgrep + dependency-review workflow are all independent of the open items.
