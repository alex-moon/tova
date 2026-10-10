# Plan — #257 Proper monorepo

## Motivation

Per GitHub issue [alex-moon/tova#257](https://github.com/alex-moon/tova/issues/257):

Today the repo is a "monorepo" only by prefix convention. The root `package.json`
holds every server, migrations and tooling dependency, while the client is wired in
with `npm --prefix src/client` hacks (`postinstall`, `install:client`, `build:client`,
`lint:client`, ...). There is no `workspaces` field, and there is no `src/server` or
`migrations` package boundary at all. Deploys install the same dependency tree five
to seven times (host, both Dockerfile builder stages, the backend prod stage, the
frontend builder) because migrations run on the host via `tsx`, forcing a full
host-side install that exists only for that.

The ticket asks for a real npm-workspaces monorepo (`client`, `server`, `migrations`),
runtime deps promoted to real deps, a Dockerfile for migrations, and a fix for the
"bogus docker pull" failures on deploy/CI (the deploy workflow's `mongo:7` service
pull failed without Docker Hub credentials).

## Decisions

- **Layout: `apps/<pkg>`** — `apps/client` (from `src/client`), `apps/server`
  (from `src/server` + the `src/index.ts` entry, kept as `index.ts`), `apps/shared`
  (from `src/shared`), `apps/migrations` (from `migrations/`). Each package keeps
  its own `src/`. The server entry lives at `apps/server/src/main.ts` (the entry and
  the `startServer` module are both named `index.ts`; the entry was renamed to
  avoid the collision).
- **`apps/shared` is a real package with a compiled boundary.** The server imports
  it as `@tova/shared`. Direct source resolution via tsconfig `paths` fails with
  TS6059 (`rootDir` must contain all program files), so shared compiles to
  `dist/contracts.{js,d.ts}` and the server consumes the declaration. All 38 exports
  are types-only, so the server's CJS emit elides every `@tova/shared` import —
  zero runtime dependency. The client keeps its `@shared` vite/tsconfig alias into
  `../shared/src`.
- **No `prepare` scripts on workspaces.** `npm ci -w apps/server` runs linked
  workspaces' `prepare` lifecycles before their sources are guaranteed present, and
  with root devDeps excluded (the whole point of a scoped install) `tsc` is absent —
  the install fails. Explicit `npm run build -w apps/shared` ordering in the root
  `build`/`typecheck` scripts replaces it.
- **Promote runtime deps.** `apps/migrations` declares `mongo-migrate-ts`,
  `dotenv`, `tsx` (it executes all three in production) and `@tova/server`; the
  server's runtime imports all live in `apps/server/package.json`; the root package
  is a thin orchestrator with tooling devDeps only.
- **Migrations run as a one-shot compose service.** `apps/migrations/Dockerfile`
  builds a self-contained runner (`npm ci -w apps/migrations`, tsx over the CLI);
  `docker-compose.live.yml` starts it on the compose network with the same `.env`
  as the backend, and the backend gates on
  `depends_on: { migrations: { condition: service_completed_successfully } }`.
  This deletes the host-side migrate-then-restart-backend dance and the
  `MONGODB_HOST=127.0.0.1` pinning hack (the container sees the DB from the same
  vantage point as the backend).
- **`scripts/deploy.sh` collapses to fetch → `compose build` → `up -d` → prune.**
  No host `node_modules`, no host builds, no host migrations. Each image installs
  only its own workspace tree (`npm ci -w <pkg>`), verified: server-scoped install
  excludes vite and root devDeps.
- **Backend image keeps the embedded client build** (the production static
  fallback served on the backend port; nginx remains the primary frontend path).
  Behavior-preserving; dropping the embed is a follow-up candidate.
- **Docker Hub auth, direct CLI, not `docker/login-action`** — the repo keeps a
  no-third-party-actions convention. On CI, jobs that pulled images as
  `services:`/`container:` (pulled before any step can authenticate) convert to
  step-based `docker login` + `docker run`: the e2e fixture Mongo and the semgrep
  scan. On deploy, `scripts/deploy.sh` pipes the token through ssh stdin to
  `docker login` on the host (the host's `compose build` is where the pulls happen).
- **`--experimental-vm-modules` stays on the test script.** Empirically required:
  `pdf-parse` → `pdfjs-dist` dynamically imports its worker (`"A dynamic import
  callback was invoked without --experimental-vm-modules"`); without the flag the
  PDF/OCR suites fail (7 tests). Removing it would mean ESM-transpiling pdfjs
  inside Jest — machinery not worth it. Documented here so nobody tries to
  cargo-cult-remove it.
- **Post-deploy eval smoke disabled** (`.github/workflows/deploy.yml`): warn-only
  (`continue-on-error`), wrote nothing the app reads (LangSmith `tova-evals` only),
  and its `mongo:7` service pull was the original "bogus docker pull" failure.

## Done

- [x] Ticket + branch `feat/tv/257-proper-monorepo`
- [x] Plan doc
- [x] `git mv` packages to `apps/*` (pure-move commit)
- [x] Workspace `package.json` files (`@tova/{client,server,shared,migrations}`) + thin root orchestrator
- [x] Runtime deps promoted (server tree in `apps/server`; migrations declare `tsx`, `dotenv`, `mongo-migrate-ts`)
- [x] Tool configs (server tsconfig into `apps/server`, shared d.ts boundary, jest/eslint/vite paths, `@tova/shared` imports)
- [x] `.gitignore`/`.dockerignore` for the new layout (root-anchored `/dist` was leaking `apps/*/dist`)
- [x] Dockerfiles + compose: workspace-scoped installs, migrations one-shot service, `deploy.sh` collapse
- [x] Docker Hub login: CI (e2e/semgrep step-based pulls), deploy (ssh-piped host login)
- [x] Post-deploy eval smoke disabled with re-enable notes
- [x] Workflow changed-area globs + AGENTS.md/README refs updated
- [x] `npm run ci` green
- [ ] PR opened

## Follow-ups

- Drop the embedded client build from the backend image (nginx is the live
  frontend path; the embed doubles the client build per deploy).
- Consider vitest for the server suite — would also retire
  `NODE_OPTIONS=--experimental-vm-modules` naturally.
- Re-enable the post-deploy eval smoke (notes in `deploy.yml`).
- `assets/` vendored tessdata still rides in the backend image; unchanged.
