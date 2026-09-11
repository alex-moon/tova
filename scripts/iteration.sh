#!/usr/bin/env bash
#
# Four-stage iteration loop over GitHub issues for this repo.
# One pass per invocation; run on an interval (cron, systemd timer, while-loop).
#
# Requires: gh (authenticated), git, opencode on PATH.

set -euo pipefail

LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/iteration-$(date +%Y%m%d-%H%M%S).log"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2; }

# Run an opencode sub-agent headlessly. $1 = title, rest = prompt.
agent() {
  local title="$1"
  shift
  opencode run --auto --title "$title" "$@" 2>&1 | tee -a "$LOG_FILE"
}

repo_due() {
  git fetch origin main --quiet || { log "git fetch failed (auth/network)"; exit 1; }
}

# ---- Phase 0: pick an issue -------------------------------------------------

repo_due

PICK_PROMPT="You are triaging the open GitHub issues for repo alex-moon/tova and picking the
next one to work on. Do NOT trust issue state alone: judge each ticket from the repo itself.

1. List: gh issue list --repo alex-moon/tova --state open --limit 50 --json number,title,updatedAt
2. For EACH issue, gather evidence before judging:
   - full conversation: gh issue view <n> --repo alex-moon/tova --comments
   - open PRs: gh pr list --repo alex-moon/tova --state open --json headRefName,title -q ...
     (a branch 'feat/tv/<n>-...' with an open PR means that ticket is in review or done)
   - the plan doc on the matching branch, if any: docs/plan-<n>-*.md, especially its
     'Done' checklist, 'Open questions' and 'Follow-ups' sections
   - whether the branch already contains commits delivering actual code for the ticket
3. Classify each issue as exactly one of:
   - DONE:   the deliverable exists and is verified (green PR/checks or work landed on main).
   - BLOCKED: progress requires something only the user can provide - an unanswered open
             question, an access request, or a decision the repo gives no basis to make.
   - READY:  work is possible now that could move the ticket forward.
   If an issue is BLOCKED and has no comment stating that it is blocked, post
   'gh issue comment <n> --repo alex-moon/tova' briefly stating why and what would unblock it
   (once per ticket; if an identical comment already exists on the ticket, do not re-post).
4. If every open issue is DONE or BLOCKED, output 'NONE'. Otherwise pick ONE issue:
   prefer tickets whose comments contain answers to previously raised open questions,
   then smaller well-scoped READY issues over sprawling ones. Never pick a DONE ticket,
   and never pick a BLOCKED ticket.
5. Output as the final line, exactly: ISSUE:<number>   (or ISSUE:NONE)"

PICK=$(agent "triage-tickets" "$PICK_PROMPT" | tail -n 1)
ISSUE=$(printf '%s' "$PICK" | grep -oE '[0-9]+' | tail -n 1 || true)
if [[ "$PICK" == *NONE* ]] || [ -z "$ISSUE" ]; then
  log "All tickets are done or blocked; nothing to do this pass"
  exit 0
fi
log "Selected issue #$ISSUE"

# ---- Branch -----------------------------------------------------------------

BRANCH=$(git branch -a --format='%(refname:short)' | grep -m1 -E "tv/${ISSUE}-" | sed 's|^origin/||' || true)
if [ -n "$BRANCH" ]; then
  git checkout "$BRANCH" >/dev/null
  git pull origin "$BRANCH" --quiet || log "pull failed; continuing with local state"
else
  NAMING_PROMPT="Issue number: $ISSUE. Run: gh issue view $ISSUE --repo alex-moon/tova
Return ONLY a branch suffix: the word feat or fix, then a hyphen, then a one or two word
lowercase hyphenated summary of the issue's subject. No other text."
  SUFFIX=$(agent "branch-name" "$NAMING_PROMPT" | tail -n 1 | tr -d ' ')
  KIND="${SUFFIX%%-*}"
  SUMMARY="${SUFFIX#*-}"
  case "$KIND" in feat|fix) ;; *) KIND=feat ;; esac
  BRANCH="$KIND/tv/$ISSUE-$SUMMARY"
  git checkout -b "$BRANCH" origin/main >/dev/null
  log "Created branch $BRANCH"
fi

# ---- Shared helpers ---------------------------------------------------------

commit_and_push() {
  local msg="$1"
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "$msg" >/dev/null
    git push -u origin "$BRANCH" --quiet
    log "Committed and pushed: $msg"
  else
    log "Nothing to commit for: $msg"
  fi
}

commit_plan() {
  if [ -n "$(git status --porcelain -- "$PLAN_FILE" 2>/dev/null docs)" ]; then
    git add docs
    git commit -m "docs: plan updates for #$ISSUE" >/dev/null
    git push -u origin "$BRANCH" --quiet
    log "Committed and pushed plan updates"
  else
    log "No plan changes to commit"
  fi
}

PLAN_FILE=$(ls docs/plan-"$ISSUE"-*.md 2>/dev/null | head -n 1 || true)

CONTEXT="You are working in the repo /opt/tova on branch $BRANCH for GitHub issue #$ISSUE
in alex-moon/tova. Read the issue (gh issue view $ISSUE --repo alex-moon/tova --comments) and,
if you need background, docs/overview.md and docs/workflow.md. Follow the repo's existing
conventions. Do NOT commit or push - the orchestrator does that. Before doing anything,
confirm from the repo's own state (not just issue comments) that this ticket is neither
already done nor blocked on the user: if it is, make sure the blocking reason is posted
as a gh issue comment on #$ISSUE and stop immediately without doing any work."

# ---- Phase 1: write plan ----------------------------------------------------

if [ -z "$PLAN_FILE" ]; then
  agent "plan-write" "$CONTEXT
Write a plan at docs/plan-$ISSUE-<summary>.md (summary matches the branch name). It must be:
a) detailed: a motivation section linking the issue, decisions so far, and a checklist of
   small tasks each safely deliverable in a single commit;
b) honest: anything you are not sure about goes under an 'Open questions' section.
Avoid planning work that depends on an open question. Commit nothing; leave the file on disk."
  PLAN_FILE=$(ls docs/plan-"$ISSUE"-*.md 2>/dev/null | head -n 1 || true)
  commit_plan
fi

# ---- Phase 2: review/harden plan --------------------------------------------

if [ -n "$PLAN_FILE" ]; then
  agent "plan-review" "$CONTEXT
The plan is at $PLAN_FILE. Review it and revise the file to make it:
a) more detailed: flesh out thin tasks into concrete steps; move anything already answered
   in the issue comments OUT of 'Open questions' and into the detailed plan;
b) more honest: criticise every assumption; move anything with ANY doubt into
   'Open questions', and make sure no planned task depends on an open question.
Post a gh issue comment on #$ISSUE for any NEW open question not already in the issue comments.
Commit nothing."
  commit_plan
else
  log "No plan file; skipping hardening"
fi

# ---- Phase 3: deliver work --------------------------------------------------

PLAN_REF="${PLAN_FILE:-no plan doc exists - work directly from the issue}"
REQ_PLAN="${PLAN_FILE:+The plan is at $PLAN_FILE.}"

if [ -z "$(git status --porcelain)" ]; then
  agent "implement" "$CONTEXT
$REQ_PLAN Read the issue comments first for answers to open questions - do only work
that is no longer blocked by an open question.
Deliver ONE stable, self-contained piece of work: either a real deliverable for the ticket,
or an intermediary that a later iteration can build on. Verify it (npm run lint, npm test,
npm run typecheck - or the relevant subset) before leaving it in the working tree.
Commit nothing."
else
  log "Dirty worktree; skipping implement phase"
fi
commit_and_push "feat: implement a deliverable for #$ISSUE"

# ---- Phase 4: critic --------------------------------------------------------

agent "critic" "$CONTEXT
$REQ_PLAN Aggressively criticise the work delivered on this branch
(git log/diff vs origin/main). Try to break it: run the relevant tests and npm run ci,
look for bugs, edge cases, missed requirements, and plan drift. Then:
- write new tests where breaking potential exists;
- make any fixes or hardening changes that are within your reach;
- update the plan doc ($PLAN_REF) with any new questions raised, under 'Open questions';
- post a gh issue comment on #$ISSUE for any open question not already in the issue comments.
Commit nothing."
commit_and_push "test/hardening: critic pass for #$ISSUE"

# ---- Phase 4.5: address PR review comments ----------------------------------

# Per owner request (issue #15, 2026-09-11): when a ticket already has an open
# PR, review comments on that PR are part of the ticket's remaining work and
# must be rectified before shipping. Note review comments left PENDING are not
# visible to the REST issue/pr comment endpoints; read them via GraphQL
# (pullRequest.reviews(states: PENDING) { comments { body path line } }).

PRNUM=$(gh pr list --repo alex-moon/tova --head "$BRANCH" --state open \
  --json number -q '.[0].number' 2>/dev/null || true)

if [ -n "$PRNUM" ]; then
  agent "pr-review-rectify" "$CONTEXT
An open PR (#$PRNUM) targets main for this branch. Read its review comments and
rectify them in the working tree:
- gh pr view $PRNUM --repo alex-moon/tova --comments
- gh api repos/alex-moon/tova/pulls/$PRNUM/comments
- PENDING reviews are not visible to the above; read them via GraphQL:
  gh api graphql -f query='... pullRequest(number: $PRNUM) { reviews(states: PENDING)
  { comments(first: 50) { body path line } } }'
Address every actionable comment (make the requested change, or reply/post on
the issue why it is handled elsewhere, e.g. split into its own ticket). Verify
with the relevant tests/npm run ci. Commit nothing."
  commit_and_push "fix: address PR review comments for #$ISSUE"
fi

# ---- PR decision ------------------------------------------------------------

agent "pr-decision" "$CONTEXT
$REQ_PLAN Decide whether this ticket is meaningfully done:
a real deliverable exists, verification passes, and remaining gaps are honest follow-ups
documented in the plan. If yes: run npm run ci; if it passes, open a PR targeting main
(gh pr create --repo alex-moon/tova --base main --head $BRANCH) with a short summary
linking the plan file, and close out. If not meaningfully done, do nothing except
post any missing open questions as a gh issue comment on #$ISSUE."
log "Pass complete for issue #$ISSUE ($BRANCH)"

git checkout main --quiet
