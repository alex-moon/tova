# Plan 20 — Share API contracts between server and client

GitHub issue: https://github.com/alex-moon/tova/issues/20
Branch: `feat/tv/20-share-api-contracts`

## Motivation

From the owner's pending review on PR #19: _"Can we share interfaces/contracts between the client and the server?"_

Today the public shapes of API request/response payloads are duplicated or server-defined only:

- `AdminUser` lives in `src/client/src/types/admin.ts` with a comment pointing a future shared contract to this ticket (done on `feat/tv/15-admin-view`); there is no corresponding exported type on the server — the projection is an untyped `toPublicUser` in `src/server/routes/admin.ts`.
- Auth routes (`src/server/routes/auth.ts`) return session/user payloads whose shapes exist only implicitly.
- Drift risk: the server projection and the client interface can diverge silently since nothing ties them together.

Goal: a single source of truth for API contract types (start with **auth, admin users**) imported by both `src/server` and `src/client`.

## Decisions so far

- Chosen location: a plain directory `src/shared/` inside the single repo package (e.g. `src/shared/contracts.ts`), **not** a separate workspace package. The repo is a single npm package with a second ad-hoc package under `src/client`; a real workspace split is out of scope for this ticket.
- Contracts must be **dependency-free** — error-driven: shared modules must not import server types or anything that pulls `mongoose`/frameworks into the client bundle (the issue flags this explicitly). Types are hand-maintained and validated against server responses by tests, not derived from Mongoose documents via types (mongoose types are not erasable/valid for client compile; `verbatimModuleSyntax` in `tsconfig.app.json` forbids runtime imports, type imports of mongoose-flavored types risk dragging in deps via `skipLibCheck` gaps).
- Contracts used as **HTTP wire types only** — interfaces for JSON bodies, not Mongo documents.

## Checklist

Each item is intended to be deliverable in a single small commit.

- [ ] 1. Create `src/shared/contracts.ts` with `AdminUser` (moved verbatim from `src/client/src/types/admin.ts`) plus auth contract types (`LoginRequest`/`RegisterRequest` bodies and the `AuthUser` payload returned by `/api/auth/me`. `src/server/routes/auth.ts` and the client's auth service must not yet be touched by this commit beyond re-export wiring is kept for later commits).
- [ ] 2. Server usage: `typecheck` include covers `src/shared` (add `src/shared/**/*.ts` to `include` in root `tsconfig.json`); apply `AdminUser`-equivalent return type to `toPublicUser` in `src/server/routes/admin.ts`; add auth request/response types to the auth routes where they don't change behavior. Server Jest `roots` are `src/server` only — leave tests where they are; shared module needs no Jest config change since it is imported, not tested, from server tests.
- [ ] 3. Client usage: add `src/shared` to `src/client/tsconfig.app.json` `include` and a Vite alias `@shared` in `src/client/vite.config.ts` (mirrors existing `@` alias); re-point `src/client/src/types/admin.ts` to re-export from shared (`export type { AdminUser } from '@shared/contracts'` pattern decided in commit 1) so existing imports keep working. Vitest picks up files outside `src` only if imported — verify client tests still pass.
- [ ] 4. Wire auth contract types into client `services` (auth calls consume the request/response types) and server auth routes use the same types.
- [ ] 5. Contract drift tests: a Jest test in `src/server` asserting the admin users route output matches `AdminUser` (key-by-key), so the shared type cannot drift from the real API response. Keep it role-slice small (uses existing admin route test patterns).
- [ ] 6. Final verify: `npm run ci` passes; update this doc, free any follow-ups, and leave the PR to the orchestrator.

## Open questions

- **Workspace package vs plain directory**: if the owner prefers a true workspace (`packages/shared` with its own `package.json`), commits 2–3 change shape (no tsconfig include needed). Defaulting to plain directory per "small reviewable increments" constraint; ask on the PR.
- **Scope of contract extraction**: does "auth, admin users" mean only these two now, or should chat streaming events (`/api/chat` SSE payloads) also get contract types in this pass? Defaulting to auth + admin only; chat contracts deferred until asked for.
- **Alias naming**: re-export-only for `src/client/src/types/admin.ts` vs full import migration to `@shared` everywhere. Defaulting to re-export shim first (minimal diff), full migration can be a follow-up issue if wanted.

## Done

- [ ] All checklist items complete, `npm run ci` green.
