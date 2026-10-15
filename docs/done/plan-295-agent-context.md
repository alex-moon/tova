# Plan — Agent: thread context + issue-body trigger (#295)

## Motivation

GitHub issue #295. The goose agent workflow (`.github/workflows/agent.yml`)
triggers only on issue/PR comments and manual dispatch, feeds goose just the
comment text plus title/body, and its working rules mis-describe the repo's
quality gate ("semgrep + e2e" instead of `npm run ci`). The owner wants to
drive the agent from PR comments and new issue bodies, with the agent always
receiving the thread's context (a PR may reference the ticket that motivated
it; a CI-fix instruction needs the check status).

## Decisions

- **Triggers stay prefix-anchored** (`startsWith '@agent'`), not substring:
  avoids accidental runs from incidental mentions. `@agent-think` keeps
  matching via the shared prefix and is stripped from the instruction.
- **Issue-body trigger is `issues: opened` only.** `edited` would re-fire the
  agent on every body edit; follow-up tasks go through comments. PR
  *descriptions* are deliberately out of scope (the user asked for PR comments
  + issue bodies); adding `pull_request: opened` means a third payload shape —
  a follow-up if wanted.
- **Context is gathered by the workflow, capped, into one file** the agent
  reads. On a PR: title/body, head/base, merge state, check rollup, the
  instruction, and referenced `#NNN` tickets (title+body each, capped at 5,
  8k chars each doc). On an issue: body, comments, referenced tickets. The
  agent still has `gh` for anything deeper (failed-log details stay an agent
  step, per the existing rule).
- **Working-rules fix:** "run `npm run ci` before opening the PR" replaces the
  wrong "check ci.yml for semgrep + e2e" line. The failed-logs rule
  (`gh run list` → `gh run view <id> --log-failed`) stays.
- **`tova-agent-workflow.md` stops carrying an embedded YAML copy.** It had
  already diverged from the live workflow (stale recipe draft); the doc keeps
  setup/provider-fallback guidance and points at the live file as the source
  of truth.
- Unchanged: model routing (`@agent` → DeepSeek V4.1 Flash, `@agent-think` →
  GLM 5.3 Flash), PR-only output (never push main), manual dispatch,
  concurrency grouping, 30-min timeout, checkout of PR head for PR comments.

## Done

- [x] Ticket #295 opened; branch + this plan.
- [x] `issues: opened` trigger added; workflow `if` covers all three events.
- [x] Unified instruction extraction (comment body | issue body | dispatch input).
- [x] Context-gathering step writes a capped context file; referenced `#NNN`
      tickets resolved for both PR and issue paths.
- [x] Working rules corrected to `npm run ci`.
- [x] `tova-agent-workflow.md` de-duplicated from the live YAML.
- [x] YAML valid under prettier (the repo's format gate covers workflows);
      embedded shell scripts pass `bash -n`.

## Follow-ups

- PR-description trigger (`pull_request: opened`) if the owner wants it.
- Posting a completion comment back on the triggering thread (needs
  `issues: write`).
