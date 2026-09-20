# Plan: orphaned branches (issue #135)

## Problem
17 non-`main` branches carried the squash-merge aftermath of tickets #94–#129:
each ticket's first pass landed on `main` via squash, while its continuation
commits (critic-pass hardening, PR review fixes) never landed. Scratch refs
(`merge-tree`, `tmp-ci-merge`) also remained from earlier merge rehearsals.

## Approach
1. Refresh `main` from `origin` (the #115 squash landed mid-pass).
2. Merge each orphaned branch into the PR branch (`feat/135-orphaned-branches`),
   resolving conflicts in favour of the newest coherent logic; keep behaviours
   newer tickets cut (e.g. `#115`'s per-provider MCP budget, `#127`'s vertical
   sources list, `#129`'s compare tab) over stale branch variants.
3. Verify every branch merges clean via `git merge-tree` (zero residual diff).
4. Drop `feat/94`'s phase-2 "DB guard tier removal" into an evidence-first
   follow-up (see AGENTS.md "Model routing decisions").
5. Run the full `npm run ci` gate.
6. Delete all absorbed branches locally; remote deletions are listed in the
   queued issue comment (the orchestrator reconciles pushes).

## Outcome
Recorded in `docs/branch-audit.md` under "Update (2026-09-20)".
