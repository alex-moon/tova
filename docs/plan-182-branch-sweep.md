# Plan — #182 Branch sweep

## Motivation

Eleven extant branches (local + `origin`) had drifted behind `main`, several by
large margins, with unknown overlap against merged squash-PRs. This sweep
audits every branch for content `main` lacks and rescues what is useful.
GitHub issue: alex-moon/tova#182.

## Method

For each branch: `git log main..branch` / `git rev-list --count` for reach,
`git diff main...branch` (content the branch adds) cross-checked against
`main`'s tree, two-dot `git diff main..branch` to detect squash-merged
branches (huge reverse-diffs mean "old copy of since-evolved files"), and the
GitHub PR/issue record. Ancestors of `main` (`git merge-base --is-ancestor`)
are fully merged by definition.

## Audit result

| Branch                          | Verdict                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/179-persistent-log`        | **Rescued here.** Loki + Alloy persistent log config; clean merge, no conflicts.                                                       |
| `feat/168-model-errors`          | **Continues on open PR #177.** Unique remainder: `ModelErrorStat` persistence, `modelErrorStatsService`, `scripts/db-sync.ts`, admin errors UI. Issue #168 itself was closed via the consolidated `feat/tv/168-170-model-pool` merge. |
| `feat/135-orphaned-branches`     | Absorbed. `turnsWithImage` gating, #117 429 surfacing, `DEEPINFRA_API_KEY`, tests all in `main`; plan doc in `docs/done/`.                                             |
| `feat/138-productivity-app`      | Absorbed (PR #140). Entity graph, extraction/retrieval services, db-dump/restore scripts in `main`.                                                                    |
| `feat/142-central-server`        | Absorbed (PRs #155/#162). Branch-unique content is only a stale `data/tova-2026-09-21.gz` dump — deliberately not carried.                                              |
| `feat/144-per-chat-incognito`    | Absorbed (PR #160). Incognito model flag, routes, tests in `main`.                                                                                                     |
| `feat/167-code-blocks`           | Absorbed (PR #172). `pre-wrap` css, fenced-block test, evals comment fix in `main`.                                                                                    |
| `feat/169-route-to`              | Absorbed (PR #176 + consolidation). `classifyPrompt`, guard history, `ROUTER_GUARD_*` in `main`.                                                                       |
| `feat/170-more-models`           | Ancestor of `main` — fully merged.                                                                                                                                     |
| `feat/tv/168-170-model-pool`     | Identical to `main` HEAD.                                                                                                                                              |
| `feat/tv/175-error-log-persistence` | Ancestor of `main` — fully merged.                                                                                                                                  |

## Decisions

- **Merge, not cherry-pick**, for `feat/179-persistent-log`: the whole branch
  is the deliverable and a `--no-ff` merge preserves its provenance
  (`e2b7314 feat: #179 persistent logs (untested)`).
- **Smoke-tested the rescued config** rather than taking "untested" at face
  value: `docker compose -p tova -f ops/loki/compose.smoke.yml up` — Alloy
  relabels and Loki ingests both stdout and stderr streams
  (`{job="tova"}` query returns the heartbeat/failure lines). Stack torn down
  afterwards.
- **`LOKI_URL` env on the backend** (compose) is kept even though `main`'s
  server code does not consume it yet: it is the intended seam for #179's
  remaining backend work.
- **No PRs duplicated**: `feat/168-model-errors` already has open PR #177,
  which stays the working surface for its remainder.

## Done

- [x] Audit all eleven branches against `main`
- [x] Ticket #182
- [x] Merge `feat/179-persistent-log` into `feat/tv/182-branch-sweep` (no conflicts)
- [x] Smoke-test Loki + Alloy (ingestion verified, stack torn down)
- [x] `npm run ci` green
- [x] PR opened

## Follow-ups

- Ticket #179 stays open for the backend log-shipping half (wiring
  `LOKI_URL`, structured logging to Loki).
- PR #177 remains open for `feat/168-model-errors`' un-consolidated remainder.
- Deleting the absorbed branches listed above is safe; deferred to owner
  confirmation.
