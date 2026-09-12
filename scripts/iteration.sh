#!/usr/bin/env bash
#
# Iteration loop over GitHub issues for this repo.
#
# Usage:
#   scripts/iteration.sh [--once] [priority-issue-number]
#
#   --once        run a single pass and exit (old cron-style behaviour).
#   priority      a GitHub issue number to prioritise, e.g. scripts/iteration.sh 34.
#                 Triage PREFERs that issue; it may still pick a different issue
#                 when that issue directly supports the priority one (unblocks it
#                 or delivers a piece the priority ticket depends on) - in that
#                 case the supporting issue's number is chosen as usual.
#
# By default the script IS the loop: passes run until the loop-decision sub-agent
# ends it, choosing DECISION:END only when all open issues are meaningfully done
# or blocked. Its reason is recorded in .iteration/loop-state.json; from then on,
# later passes performs only a limited GH check that looks for NEW information in
# the issues since the decision (new comments/answers, new issues, new PRs). A
# check with no new information is one strike; after $STRIKE_LIMIT strikes the
# loop exits for good. Any new information clears the decision and work resumes.
# A pass whose triage returns ISSUE:NONE also counts as a strike directly.
#
# Env: STRIKE_LIMIT (default 3), PASS_INTERVAL (seconds between passes, default 900).
# Requires: gh (authenticated), git, opencode on PATH.

set -euo pipefail

LOG_DIR="logs"
STATE_DIR=".iteration"
STATE_FILE="$STATE_DIR/loop-state.json"
STRIKE_LIMIT=${STRIKE_LIMIT:-3}
PASS_INTERVAL=${PASS_INTERVAL:-900}
mkdir -p "$LOG_DIR" "$STATE_DIR"
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

# ---- Loop state -------------------------------------------------------------
# .iteration/loop-state.json: {strikes, decidedAt, reason, mode}
#   mode "decision": the loop-decision agent ended the loop; later passes run
#                    only the limited shutdown check until strikes exhaust.
#   mode "strikes":  triage keeps finding nothing to do; strikes accumulate
#                    across passes and trip the same limit. This is NOT the
#                    limited-check mode.

state_get() { node -p "JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).$1 || ''" 2>/dev/null || echo ""; }

write_state() { # $1=strikes $2=mode $3=decidedAt $4=reason (plain text)
  ITER_STATE_STRIKES=$1 ITER_STATE_MODE=$2 ITER_STATE_AT=$3 ITER_STATE_REASON=$4 \
  node -e "require('fs').writeFileSync('$STATE_FILE', JSON.stringify({
strikes: Number(process.env.ITER_STATE_STRIKES),
mode: process.env.ITER_STATE_MODE || null,
decidedAt: process.env.ITER_STATE_AT || null,
reason: process.env.ITER_STATE_REASON || null,
}, null, 2))"
}

add_strike() { # $1=mode $2=reason; returns 0 to keep looping, 1 to stop
  local n decidedAt reason
  n=$(( $(state_get strikes) + 1 ))
  decidedAt=$(state_get decidedAt)
  if [ -z "$decidedAt" ]; then
    decidedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    reason="$2"
  fi
  write_state "$n" "$1" "$decidedAt" "$2"
  log "Strike $n/$STRIKE_LIMIT: $2"
  [ "$n" -ge "$STRIKE_LIMIT" ] && return 1
  return 0
}

clear_shutdown() {
  rm -f "$STATE_FILE"
  log "Decision overturned - new information in GitHub issues; resuming full work"
}

# Limited check for new information since the recorded shutdown decision.
# Exit 0: resume full work. Exit 2: strike, skip work phases but keep looping.
# Exit 1: strikes exhausted; stop the loop.
check_shutdown() {
  local decidedAt verdict
  decidedAt=$(state_get decidedAt)
  local priority_note=""
  if [ -n "$PRIORITY" ]; then
    priority_note="Note: the user has marked issue #$PRIORITY as PRIORITY - also check
whether it specifically now shows new information."
  fi
  local check_prompt="A previous iteration of this loop has already decided that all
GitHub issues for repo alex-moon/tova are either meaningfully done or blocked.
Decision recorded at: $decidedAt
Reason: $(state_get reason)

Perform a LIMITED check only - do not re-run full triage, do not do any work.
Look ONLY for new information in GitHub issues since $decidedAt that could change
that decision:
- gh issue list --repo alex-moon/tova --state open --json number,title,updatedAt
- for issues updated after $decidedAt: gh issue view <n> --repo alex-moon/tova
  --comments - does the new material ANSWER a previously blocking open question,
  add new requirements, or otherwise make meaningful work possible again?
- gh issue list --repo alex-moon/tova --state open --json
- gh pr list --repo alex-moon/tova --state open --json number,title,updatedAt
$priority_note

Answer with exactly one final line:
NEW:<one short reason the decision may change>
NONE"
  verdict=$(agent "loop-check" "$check_prompt" | tail -n 1)
  if [[ "$verdict" == NEW:* ]]; then
    clear_shutdown
    return 0
  fi
  log "No new information in GitHub issues since $decidedAt"
  if add_strike "decision" "limited shutdown check found no new information since $decidedAt"; then
    return 2
  fi
  log "Decision exhausted $STRIKE_LIMIT strikes; ending loop"
  return 1
}

# ---- Loop-decision agent: runs after a productive pass -----------------------

decide_loop() {
  local decision
  decision=$(agent "loop-decision" "You have just completed an iteration pass on the GitHub
issues of repo alex-moon/tova. Recent activity is visible in logs/iteration-*.log, plan docs
in docs/, open PRs and issue comments in GitHub. Decide whether the iteration loop should
CONTINUE or END.

END the loop when: all open issues are meaningfully done or blocked, and what remains needs
only the user (answers to open questions, access, decisions) with nothing actionable left.
Otherwise CONTINUE.

Answer with exactly one final line:
DECISION:CONTINUE
DECISION:END - <one short reason the loop is stopping>" | tail -n 1)
  if [[ "$decision" == DECISION:END* ]]; then
    local reason="${decision#DECISION:END}"
    reason="${reason#- }"
    log "loop-decision recorded shutdown: $reason"
    write_state 0 "decision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$reason"
    return 1
  fi
  log "loop-decision: continue"
  return 0
}

# ---- Pass body --------------------------------------------------------------

run_pass() {
  ISSUE_WORKED=""
  local pick

  repo_due

  # Phase 0: pick an issue.
  local pick_prompt
  pick_prompt="You are triaging the open GitHub issues for repo alex-moon/tova and picking the
next one to work on. Do NOT trust issue state alone: judge each ticket from the repo itself."
  if [ -n "$PRIORITY" ]; then
    pick_prompt+="

The user has marked issue #$PRIORITY as PRIORITY. Prefer it: if it is READY, pick it even
if other issues are smaller or more recently updated. You MAY pick a different issue only
when it directly supports the priority ticket (unblocks it or delivers a prerequisite the
priority ticket depends on) - in that case output the supporting issue's number. If the
priority issue is DONE or BLOCKED, classify it exactly as you would any other ticket."
  fi
  pick_prompt+="

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

  pick=$(agent "triage-tickets" "$pick_prompt" | tail -n 1)
  log "Triage verdict: $pick"
  if [[ "$pick" == *NONE* ]]; then
    if add_strike "strikes" "triage returned ISSUE:NONE"; then
      return 0
    fi
    log "All work blocked for $STRIKE_LIMIT consecutive passes; ending loop"
    return 1
  fi

  ISSUE=$(printf '%s' "$pick" | grep -oE '[0-9]+' | tail -n 1 || true)
  if [ -z "$ISSUE" ]; then
    log "Triage produced no issue number; treating as unproductive pass"
    if add_strike "strikes" "triage produced no issue number"; then
      return 0
    fi
    log "All strikes exhausted; ending loop"
    return 1
  fi
  log "Selected issue #$ISSUE"
  ISSUE_WORKED=1

  # ---- Branch ----

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

  # ---- Shared helpers ----

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

  # ---- Phase 1: write plan ----

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

  # ---- Phase 2: review/harden plan ----

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

  # ---- Phase 3: deliver work ----

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

  # ---- Phase 4: critic ----

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

  # ---- Phase 4.5: address PR review comments ----

  # Per owner request (issue #15, 2026-09-11): when a ticket already has an open
  # PR, review comments on that PR are part of the ticket's remaining work and
  # must be rectified before shipping. Note review comments left PENDING are not
  # visible to the REST issue/pr comment endpoints; read them via GraphQL
  # (pullRequest.reviews(states: PENDING) { comments { body path line } }).

  prnum=$(gh pr list --repo alex-moon/tova --head "$BRANCH" --state open \
    --json number -q '.[0].number' 2>/dev/null || true)

  if [ -n "$prnum" ]; then
    agent "pr-review-rectify" "$CONTEXT
An open PR (#$prnum) targets main for this branch. Read its review comments and
rectify them in the working tree:
- gh pr view $prnum --repo alex-moon/tova --comments
- gh api repos/alex-moon/tova/pulls/$prnum/comments
- PENDING reviews are not visible to the above; read them via GraphQL:
  gh api graphql -f query='... pullRequest(number: $prnum) { reviews(states: PENDING)
  { comments(first: 50) { body path line } } }'
Address every actionable comment (make the requested change, or reply/post on
the issue why it is handled elsewhere, e.g. split into its own ticket). Verify
with the relevant tests/npm run ci. Commit nothing."
    commit_and_push "fix: address PR review comments for #$prnum"
  fi

  # ---- PR decision ----

  agent "pr-decision" "$CONTEXT
$REQ_PLAN Decide whether this ticket is meaningfully done:
a real deliverable exists, verification passes, and remaining gaps are honest follow-ups
documented in the plan. If yes: run npm run ci; if it passes, open a PR targeting main
(gh pr create --repo alex-moon/tova --base main --head $BRANCH) with a short summary
linking the plan file, and close out. If not meaningfully done, do nothing except
post any missing open questions as a gh issue comment on #$ISSUE."

  log "Pass complete for issue #$ISSUE ($BRANCH)"
  git checkout main --quiet
  return 0
}

# ---- Main loop ---------------------------------------------------------------

PRIORITY=""
ONCE=""
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    '')
      ;;
    *)
      if [ -n "$PRIORITY" ]; then
        log "Too many arguments: pass at most one issue number"
        exit 1
      fi
      [[ "$arg" =~ ^[0-9]+$ ]] || { log "Priority must be an issue number, got: $arg"; exit 1; }
      PRIORITY=$arg
      log "Priority issue #$PRIORITY set"
      ;;
  esac
done

while true; do
  ISSUE_WORKED=""
  STALE=0
  if [ -f "$STATE_FILE" ] && [ "$(state_get mode)" = "decision" ]; then
    check_shutdown
    case $? in
      1) exit 0 ;;        # strikes exhausted - loop is over
      2) STALE=1 ;;       # strike registered; limited check again next pass
      0) : ;;             # new information - resume full work
      *) continue ;;
    esac
  fi
  if [ "$STALE" -eq 1 ]; then
    [ -n "$ONCE" ] && exit 0
    log "Shutdown in effect; next limited check in ${PASS_INTERVAL}s"
    sleep "$PASS_INTERVAL"
    continue
  fi

  pass_ok=0
  if ! run_pass; then
    pass_ok=1
  fi
  if [ "$pass_ok" -eq 0 ] && [ -n "$ISSUE_WORKED" ]; then
    # Meaningful work happened this pass: ask the loop-decision agent whether to continue.
    if ! decide_loop; then
      STALE=1
    fi
  fi

  [ -n "$ONCE" ] && exit 0
  log "Next pass in ${PASS_INTERVAL}s"
  sleep "$PASS_INTERVAL"
done
