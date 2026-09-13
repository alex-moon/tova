# Plan — Deploy GitHub workflow (issue #11)

## Motivation

Issue #8 added `npm run deploy` (manual ssh deploy base). The owner wants automatic deploys
to ajmoon.com from GitHub Actions: on push to `main`, and only if CI passed. Owner sets up
the ssh key secrets.

## Decisions

- Separate `.github/workflows/deploy.yml`, triggered by `workflow_run` of the CI workflow:
  `needs:` only works inside one workflow, and `ci.yml` runs both `pull_request` and `push`,
  so `workflow_run` + `conclusion: success` + branch check is the clean way to enforce
  "only main pushes with CI green".
- The deploy job runs `scripts/deploy.sh` from the runner: it drives ssh to `ajmoon`, which
  clones/resets `/opt/tova` to `origin/main`, installs, builds, brings the stack up, runs
  migrations, and restarts the backend (order per plan #8).
- Secrets required: `SSH_PRIVATE_KEY` (key authorized for the `ajmoon` ssh alias on the
  runner host) and `SSH_KNOWN_HOSTS` (for store of ajmoon.com coerce).

## Done

- [x] `.github/workflows/deploy.yml` added (workflow_run gate; push to main + CI success)
- [ ] Verified (workflow is ssh-gated; verified by YAML validity and by a main push after merge)

## Follow-ups

- N/A
