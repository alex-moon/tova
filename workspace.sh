#!/bin/bash

# Delivery loop for epic #251. The loop's mechanics live here; docs/plan-251-workspace.md
# is epic *state* only (invariants, decisions, Done checklist, open questions). Do not
# move this protocol back into the doc: the loop must not read its own instructions.
#
# Each iteration: sync the epic branch, reconcile epic state against git/GitHub, do the
# next unchecked task, then critically review and record. Every step commits and pushes
# its own work before handing off, so state is durable if the loop dies mid-iteration —
# but only if there is work to commit; a step that finds nothing to change commits
# nothing. The agent judges its own work and the tickets against what is actually in the
# code and the issues — no per-step checklist here.

set -euo pipefail

EPIC_BRANCH="epic/251-workspace"

while true; do
  git checkout "$EPIC_BRANCH"
  git pull --ff-only

  # Reconcile state only: bring the doc's Done checklist, tickets, PRs, and branches
  # back in line with reality. This step edits *content*, never the loop protocol.
  opencode run "Read docs/plan-251-workspace.md plus the open slice plans, tickets, PRs, and branches for #251. Reconcile the doc's Done checklist and open-questions list against the actual git and GitHub state. Fix drifted state in the doc, but do not edit the loop protocol or workspace.sh. If the state already matches reality, change nothing. Commit and push any changes before finishing. Report what is next."

  DATE=$(date -Iseconds)

  opencode run "Complete the next unfinished task on epic #251. Follow docs/workflow.md and the epic's binding invariants. Update the epic doc's Done checklist as you go. Commit and push your work before finishing, but if you completed nothing, commit nothing."

  opencode run "Look at the work done on this repo since $DATE. Criticise and harden it against the code and the tickets: find where it breaks and fix it, where it is weak and strengthen it, where it is ambiguous and clarify it. Verify with npm run ci. If the existing work is satisfactory, change nothing. Commit and push your fixes before finishing."

  opencode run "Look at the work done on this repo since $DATE. Ensure it is documented in the right places (docs/, PRs, branches) and append the outcome to the epic doc's process log. If everything is already documented and pushed, change nothing. Commit and push everything before finishing."

  sleep 30
done
