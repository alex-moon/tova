# Plan — #257 Proper monorepo

## Motivation

Per GitHub issue [alex-moon/tova#257](https://github.com/alex-moon/tova/issues/257):

Today the repo is a "monorepo" only by prefix convention. The root `package.json`
holds every server, migrations and tooling dependency, while the client is wired in
with `npm --prefix src/client` hacks (`postinstall`, `install:client`, `build:client`,
`lint:client`, ...). There is no `workspaces` field, and there is no `src/server` or
`migrations` package boundary at all.

The ticket asks for a real npm-workspaces monorepo with three (four, see Decisions)
workspaces, plus a fix for the "bogus docker pull" failures on deploy/CI.

The docker-pull portion is the fail-closed symptom we just hit: the deploy
workflow's post-deploy eval smoke pulled a `mongo:7` service container anonymously,
which fails when Docker Hub rate-limits or requires a token. The smoke was
warn-only (`continue-on-error`) and pushed only to the LangSmith `tova-evals`
dataset, so it has been disabled (see Decisions).

## Decisions

- **Layout: `apps/<pkg>`** — `apps/client` (from `src/client`), `apps/server`
  (from `src/server` + the `src/index.ts` entry), `apps/shared` (from `src/shared`),
  `apps/migrations` (from `migrations/`). Each package keeps its own `src/`.
- **`apps/shared` is its own package** — both server and client consume
  `src/shared/contracts.ts`. The client already reaches it through an `@shared`
  alias (`src/client/vite.config.ts`, `tsconfig.app.json`); the server uses relative
  `../../shared/contracts`. Making it a workspace keeps the boundary explicit and
  removes cross-package relative climbs.
- **Server entry stays `index.ts`** — the ticket's "main.ts" was illustrative only;
  `index.ts` is the idiomatic Node entry. `src/index.ts` -> `apps/server/src/index.ts`.
- **Migrations gets its own `src/`** — `apps/migrations/src/*`, consistent with the
  other packages.
- **npm workspaces, root is a thin orchestrator** — root keeps only cross-cutting
  scripts (deploy, db, logs, e2e) and the shared tooling configs; per-package deps
  live in their package.
- **Promote runtime deps** — deps the production container actually executes at
  runtime must not be dev-only. In particular the deploy runs migrations via `tsx`
  against `apps/migrations`, so `tsx` (and anything migrations/server actually
  import at runtime) is a real dependency of its package, not a root devDependency.
- **Docker Hub login in CI/deploy** — authenticate Docker Hub pulls with the
  `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets (via `docker/login-action`)
  so base-image and public-image pulls are not anonymously rate-limited.
- **Disable the post-deploy eval smoke** — it was warn-only and wrote only to the
  LangSmith `tova-evals` dataset (nothing the app reads); it was the direct cause of
  the failing `mongo:7` pull. Disabled in `.github/workflows/deploy.yml`, with a
  comment recording how to re-enable it (including the Docker Hub login). The
  nightly all-models sweep is a separate job and is unaffected.

## Done

- [ ] Ticket + branch `feat/tv/257-proper-monorepo`
- [ ] Plan doc
- [ ] `git mv` packages to `apps/*`
- [ ] Workspace `package.json` files (client/server/shared/migrations) + thin root
- [ ] Promote runtime deps out of dev
- [ ] Tool configs updated (tsconfig, tsconfig.test, jest, eslint, prettier, imports)
- [ ] Dockerfiles + compose updated to the `apps/` layout
- [ ] Docker Hub login added to CI/deploy
- [ ] Post-deploy eval smoke disabled
- [ ] Workflow changed-area globs + AGENTS.md refs updated
- [ ] `npm run ci` green
- [ ] PR opened

## Follow-ups

- Re-enabling the post-deploy eval smoke once Docker Hub auth is in place (tracked
  in the comment in `deploy.yml`).
