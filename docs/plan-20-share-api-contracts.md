# Plan 20 — Share API contracts between server and client

GitHub issue: https://github.com/alex-moon/tova/issues/20
Branch: `feat/tv/20-share-api-contracts`

## Motivation

From the owner's pending review on PR #19: _"Can we share interfaces/contracts between the client and the server?"_

Today the public shapes of API request/response payloads are duplicated or server-defined only:

- `AdminUser` lives in `src/client/src/types/admin.ts` with a comment pointing a future shared contract to this ticket (done on `feat/tv/15-admin-view`); the server has only an untyped projection `toPublicUser` in `src/server/routes/admin.ts:17-25`.
- Auth routes (`src/server/routes/auth.ts`) return session/user payloads (`/register` :57, `/login` :74, `/me` :185-187) whose shapes exist only implicitly; the client duplicates them as `User` in `src/client/src/context/AuthContext.tsx:4-9`.
- Drift is already visible: client `User` declares `permissions: string[]`, but `/login` and `/register` return a user object **without** `permissions` — the shared contract must document this, not paper over it.

Goal: a single source of truth for API contract types (start with **auth, admin users**) imported by both `src/server` and `src/client`.

## Decisions (evidence-backed, from repo state)

- **Plain directory `src/shared/`, not a workspace package.** The repo is a single npm package (`package.json` at root) with one ad-hoc second package under `src/client` (own `vite.config.ts`, `tsconfig`, no `package.json` beyond-local deps). Introducing a real workspace (`packages/shared` + workspaces field in root `package.json`, hoisting changes) is a build-system migration, not a contract extraction — out of scope for this ticket. Verified: `src/client` has no manifest of its own that a workspace split could hook into cleanly.
- **Contracts are dependency-free, hand-maintained interfaces.** Not derived from Mongoose typings: `verbatimModuleSyntax` + `erasableSyntaxOnly` in `src/client/tsconfig.app.json:14,22` forbids runtime imports and makes importing mongoose-flavoured types risky for the client compile; `skipLibCheck` doesn't fully protect against pulled-in dependency types. Shared modules must only import from typescript-builtin / nothing at all. `src/shared/*.ts` must contain only `interface`/`type`/`export type` declarations — no runtime code imports — so the same file is valid under `module: commonjs` (server, `tsconfig.json`) and `module: esnext` + `verbatimModuleSyntax` (client).
- **Contracts are HTTP wire types only** — shapes of JSON bodies as they appear after `res.json()` / `JSON.parse`, not Mongo documents. Consequence already encoded in `AdminUser`: `createdAt`/`updatedAt` are `string` on the wire even though the server's mongoose `Date` on `toPublicUser` returns a `Date` object in-process; the drift test below exists precisely to pin this serialization.
- **No server behavior changes in this ticket.** Where client and server disagree (see findings above), the contract captures the current wire shape and the disagreement is logged as an open question / follow-up, not "fixed" silently inside a refactor.
- **Re-export shim strategy:** `src/client/src/types/admin.ts` becomes a re-export (`export type { AdminUser } from ...`), so all existing client imports keep working. Full import migration to an alias is a follow-up if the owner wants it.

## Detailed plan

Each item is one small, reviewable commit.

- [x] 1. Create `src/shared/contracts.ts`, dependency-free, containing:
  - `AdminUser` — moved verbatim from `src/client/src/types/admin.ts:6-14` (same fields, same comment intent pointing at `toPublicUser`).
  - `AuthUser` — `{ id: string; email: string; role: 'user' | 'admin'; permissions: string[] }` matching `/api/auth/me` (`auth.ts:185-187`). Note: server code currently does not call `user._id.toString()` here (unlike `toPublicUser`) — it still serialises to a string over JSON; if typing the handler requires it, switch to `user._id.toString()` — behavior on the wire is unchanged.
  - `LoginUserPayload` — `{ id: string; email: string; role: 'user' | 'admin' }` matching `/login` and `/register` responses (no `permissions`). Document on the interface that the client currently types a wider `User` than these routes return (open question below).
  - Request bodies `LoginRequest { email: string; password: string }`, `RegisterRequest` (same shape).
  - `src/client/src/types/admin.ts` untouched in this commit.
- [x] 2. Server adoption. `tsconfig.json` `include` at line 14 already covers `src/index.ts` + `src/server/**`; add `src/shared/**/*.ts` to it. `rootDir: "src"` already spans `src/shared`, so `tsc --noEmit` typecheck needs no other change (verified config). Apply:
  - `toPublicUser` in `src/server/routes/admin.ts` gets return type `AdminUser`; if `createdAt`/`updatedAt` (mongoose Date) do not satisfy `string`, serialize explicitly (`user.createdAt.toISOString()`) — wire behavior identical, removed doubt.
  - `/register`, `/login`, `/me` handlers get their response literals typed as the contract shapes above.
  - No Jest config change: `src/server` tests import `../shared/contracts` relatively or via the same package resolution; `roots` need not change (verify by running `npm run test:server`).
- [x] 3. Client tooling wiring. In `src/client/tsconfig.app.json`: add `"@shared/*": ["../shared/*"]` to `paths` (or `"@shared/*": ["../../src/shared/*"]` — relative to tsconfig; verify with `npm run typecheck` from root and client build). In `src/client/vite.config.ts`: add alias `@shared` → `../../src/shared` (mirroring the existing `@` alias at line ~20 — both `vite` and `vitest` resolve aliases from this config, so client tests importing `@shared` work; files outside the client `include` are still compiled because they are imported). Re-point `src/client/src/types/admin.ts` to `export type { AdminUser } from '@shared/contracts';` (re-export shim). Run `npm run test:client` and `npm --prefix src/client run build` to confirm.
- [x] 4. Wire auth types into both sides: client `AuthContext.tsx` imports the contract types for its `User`/setters (client `User` remains as-is or narrows to contract — do whichever produces zero runtime change; if the client keeps its own wider `User`, convert it to a re-export of `AuthUser` + a comment about the login-payload gap). Server auth routes consume the same types (done in commit 2 can be split here if the diff gets large).
- [x] 5. Drift test in `src/server/routes/admin.test.ts` (or a new small test file): assert `toPublicUser` output keys and value types match `AdminUser` field-for-field (already-proven fixture pattern in `admin.test.ts`). If step 3 allowed limited extraction, keep it role-slice small.
- [x] 6. Final verify: `npm run ci` (server lint, format, typecheck, server tests, client lint/format/tests/build). `npm run lint` covers `src/` so `src/shared` is included automatically (ESLint flat config over `src migrations`). Update this doc, note any follow-ups, leave the PR to the orchestrator.

## Assumptions audited (honesty pass)

- Assumption "plain directory works across tsx/Jest/Vite/tsconfig" — verified against each config above; the one real risk is `paths`/`moduleResolution: bundler` relative-to-tsconfig behavior, which is why commit 3 ends in a full client build, not just a typecheck.
- Assumption "contracts stay dependency-free" — holds for hand-written interfaces; would break instantly if someone later imports a server type for convenience. Mitigation is convention + review note, nothing enforceable without extra tooling (a lint rule or dependency-cruiser is a possible follow-up, not in scope).
- Assumption "wire-only contracts" — `Date` fields serialize as ISO strings; this was an existing implicit arrangement that `AdminUser` already encodes; commit 2 makes the server side explicit so the type and runtime agree.
- **Finding (not silently fixed):** client `AuthContext.User` is wider than what `/login`//: register` return. Captured in open question "auth payload symmetry".
- **Finding:** `KNOWN_PERMISSIONS` (`src/server/routes/admin.ts:10`) is a runtime constant but the contract types `permissions` as `string[]`. A narrower contract (`'routing'`-style union) would drift out of sync with the server-owned list. Kept `string[]`; narrowing is an open question.

## Open questions

Each question below is non-blocking: every checklist task proceeds under the stated default and no task's success depends on the answer.

- **Auth payload symmetry** (new, posted to issue): `/login` and `/register` return `{ id, email, role }` without `permissions`, while `/me` includes `permissions`. Should the server add `permissions` to login/register responses so one `AuthUser` type covers all three, or keep two payload types as planned? Defaulting to two types (no behavior change); posted on #20.
- **Permission narrowing** (new, posted to issue): should `permissions` in shared contracts be typed as the known-permission union (e.g. `'routing'`) instead of `string[]`? Server-owned `KNOWN_PERMISSIONS` would need to become the single source (duplicating it in a shared file re-creates a drift site). Defaulting to `string[]` in this pass; posted on #20.
- **Chat/SSE contract scope** (carried from plan, now posted to issue): whether `/api/chat` SSE/streaming payloads also get contract types in this pass. Defaulting to no — auth + admin only per the issue goal; posted on #20.

Resolved (moved out of open questions):

- ~~Workspace package vs plain directory~~ — resolved by repo state: single package, no client manifest; a workspace split is a separate ticket if the owner wants one.
- ~~Re-export shim vs full alias migration~~ — decided: shim in this ticket, full migration as a follow-up issue (minimal diff wins).

## Done

- [x] All checklist items complete, `npm run ci` green.

## Implementation notes (2026-09-11)

- Open questions stayed open: implemented under the stated defaults — two auth payload types
  (`AuthUser` for `/me`, `LoginUserPayload` for `/login`//`register`), `permissions: string[]`,
  no chat/SSE contracts.
- `tsconfig.app.json` uses `"@shared/*": ["../shared/*"]` (relative to `src/client`); Vite alias
  `@shared` → `../shared`. Import must be `import type ... from '@shared/contracts'` on the
  client (`verbatimModuleSyntax`).
- Server: `toPublicUser` now serialises `createdAt`/`updatedAt` explicitly with `toISOString()`
  (wire behavior unchanged, now type-checked against `AdminUser`); auth handlers build typed
  payload consts and use `user._id.toString()` (wire behavior unchanged — ObjectId already
  serialized to a string over JSON).
- Client drift finding stays unfixed by design (open question 1): `AuthContext.User` is a
  re-export of `AuthUser`, still wider than login/register payloads; documented in code and on #20.
- Drift test added to `admin.test.ts`: asserts the wire payload of `GET /api/admin/users`
  matches the `AdminUser` field set and value types exactly.
