# Plan — Reimplement scripts/iteration.sh as a typed TypeScript harness

## Motivation

GitHub issue: https://github.com/alex-moon/tova/issues/37

`scripts/iteration.sh` has grown past what bash holds comfortably: the
shutdown/strikes state machine is written/read via `node -e` one-liners, pass
outcomes are signalled through exit codes and `set -e` plumbing, and agent
verdicts are parsed as a fragile last-line protocol with no validation or
retry. Every sub-agent phase also re-gathers the same GitHub evidence through
repeated `gh` calls. A TypeScript harness collects state once per pass,
injects structured snapshots into each phase prompt, and validates verdicts.

## Decisions

- **Single file** `scripts/iteration.ts`, run via `npx tsx scripts/iteration.ts`
  (same pattern as `scripts/mongo.ts`; tsx already available in-repo).
- **No new runtime dependencies**: use `node:child_process` (`execFileSync`)
  and `gh` CLI exactly as the shell version does. `tsx` is in devDependencies.
- **Types surfaced at the top** of the file: `LoopState`, `PassSnapshot`,
  `IssueInfo`, `PrInfo`, verdict schemas (`TriageVerdict`, `LoopDecisionVerdict`,
  `CheckVerdict`), parsed with small hand-written validators + a schema echo on
  retry (avoids pulling zod/ajv into a dev-only script).
- **Verdict protocol change**: agents return JSON on the final line
  (`{"issue": 34}` / `{"decision": "END", "reason": "..."}` / `{"verdict":
"NEW", "info": "..."}`). Harness extracts the last JSON object it can parse
  from the output, validates against the schema, retries the agent once with
  the schema + validation error included, then hard-fails the pass (logged,
  never silently skipped).
- **Pass semantics preserved 1:1**: exit-code meanings of `add_strike`
  (0 keep looping / 1 stop) and `check_shutdown` (0 resume / 2 strike / 1 stop)
  become explicit result values, not magic integers.
- **State file compatibility**: `.iteration/loop-state.json` keeps the exact
  same shape and location; existing state files (if any) load unchanged.
- **CLI/env parity**: `scripts/iteration.ts [--once] [priority-issue-number]`,
  `STRIKE_LIMIT` (3), `PASS_INTERVAL` (900). `STRIKE_INTERVAL` in the ticket
  text is treated as a typo for `PASS_INTERVAL` — see ticket comment.
- **Phase parity**: triage → plan-write → plan-review → implement → critic →
  pr-review-rectify (only when a PR exists) → pr-decision, run via
  `opencode run --auto --title <phase> -- <prompt>` with output teed to a pass
  log file under `logs/`.
- **Prompt text preserved** (slightly lightly edited for the JSON verdicts);
  context injection adds a `PASS SNAPSHOT` JSON blob with the per-pass
  gathered state that each phase's prompt includes.
- **Out of scope** (from the ticket): runtime gh tools for agents, sandbox /
  LangSmith flows, changing agent-facing paths.

## Done

- [x] Branch `feat/tv/37-iteration-harness` created; draft PR opened early.
- [x] Plan doc written and mirrored to the ticket as a comment.
- [x] `scripts/iteration.ts` implements: args/env parsing, logger, loop state
      read/write, agent runner (tee to log pass file), snapshot gathering
      (issues + comments, open PRs incl. PENDING reviews, plan docs),
      typed verdict extraction/validation/retry, pass body (triage, branch,
      plan, implement, critic, pr-review-rectify, pr-decision), main loop
      with `--once` and shutdown-check parity.
- [x] Unit coverage for the typed verdict protocol and the loop-state
      round-trip (`src/server/iteration-harness.test.ts`, 9 tests; ts-jest
      now uses `tsconfig.test.json` without `rootDir` so the suite can import
      `scripts/iteration.ts` directly).
- [x] CLI guard verified: `npx tsx scripts/iteration.ts abc` exits 1 with a
      clear message before any pass starts.
- [x] Shell script removed in favour of the TS harness entrypoint
      (`feat/tv/37-remove-iteration-sh`); user confirmed deletion
      ("Delete iteration.sh — iteration.ts is definitely better by default").
- [x] `npm run lint`, `npm run typecheck`, `npm test`, `npm run format:check`
      clean in PR #39 (green before merge).

## Follow-ups

- Demo/supervised `--once` run of `iteration.ts` + a new UX ticket
  (follow-ups UI, sources collapse, dark theme) — user asked for this in the
  ticket thread; tracked on GitHub as separate work, not part of this PR.

## Open questions

- (resolved) Delete `scripts/iteration.sh`: yes, per user's ticket comment.
