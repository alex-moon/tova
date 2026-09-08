# Plan — Deploy pipeline and CI workflows (issue #8)

## Motivation

Two infra gaps: there is no deploy path to production (ajmoon.com), and no CI runs
lint/format/tests on pushes or PRs to `main`. Reference for deploy shape: `Makefile.bak`
(ported from another repo, adapted for tova) — ssh deploy to `/opt/<app>`, git clone/reset,
install + build, docker-based deploy.

## Decisions

- **Deploy as npm script, not Makefile** — per owner: `npm run deploy`. The shell logic lives
  in `scripts/deploy.sh` (avoids escaping a full ssh script inside package.json); the npm
  script just calls `bash scripts/deploy.sh`.
- **Deploy mirrors Makefile.bak** adapted to this repo:
  clone into `/opt/tova` if missing, `git reset --hard origin/main`, `npm install`,
  build (`npm run build && npm run build:client`), then `docker compose` based deploy using
  the existing `docker-compose.live.yml`. The docker stack/converge + php image steps from
  the reference repo (a PHP app) are dropped as not applicable.
- **CI**: single workflow file `.github/workflows/ci.yml` running on `push` to `main` and
  `pull_request` targeting `main`. Uses existing scripts: server lint/fmt/typecheck/tests +
  client lint/fmt/tests — delegates to `npm run ci` (which is exactly this set plus the
  client build). Node 22 (matches local env).

## Done

- [x] npm script `deploy` + `scripts/deploy.sh` added
- [x] `.github/workflows/ci.yml` added
- [x] Verified locally where possible (deploy is ssh-gated; CI verified by push)

## Follow-ups

- The `frontend`/`backend` services in `docker-compose.live.yml` run `npm run dev` in
  development mode with bind mounts — a real prod deploy likely wants prod builds. Deferred:
  https://github.com/alex-moon/tova/issues/9
