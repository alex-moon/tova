# Plan: #3 Google OAuth sign-in + user permissions

## Scope

From #3 (Google OAuth), plus scoped additions per ticket comment:

1. Google OAuth sign-in (`/api/auth/google` + callback), reusing the JWT cookie session.
2. User resolution: callbacks/upserts resolve a user by email — existing email resolves to that user (Google identity linked); otherwise a new user is created.
3. Permission system: users carry `permissions: string[]`. New users do **not** get `routing`, so they cannot use the model router; chat shows an error instead.
4. Migration granting `routing` to the seeded `formsatz@gmail.com`.

## Design

- Permission key: `routing` (the model-router permission). Guard lives in `routerService`-adjacent helper checked in both chat routes (`/api/chat`, `/api/chat/stream`).
- Chat surfaces permission errors through the existing error path: SSE `error` event (stream) or 403 JSON (non-stream). Client passes the server message through to the error bubble.
- `resolveOrCreateUser(email, { googleId })` in `userService.ts`: find by email → link `googleId` if absent; else create with `permissions: []` and unusable random password hash.
- OAuth: consent redirect builds from `GOOGLE_CLIENT_ID` / `GOOGLE_CALLBACK_URL`; callback exchanges the code at Google, decodes the id_token, resolves/creates the user, issues the standard cookie.
- Migration `20260908120000-grant-routing-permission` `$addToSet`s `routing` for `formsatz@gmail.com`.

## Steps

- [x] Ticket comment on #3
- [x] Branch `feat/tv/3-user-permissions`
- [x] User model `permissions`; `userService` (resolve, permission check)
- [x] Auth routes: google redirect/callback; chat routes: guard
- [x] Migration + README env docs
- [x] Tests (oauth upsert/link, permission guard streams error), lint/typecheck/format/CI
- [x] PR, archive plan doc
