# Plan: #364 comment cull

## Intent

Sweep the entire codebase and cut every comment down to a single line of high-level intent, with one following `@see #NNN` line when ticket numbers were referenced. Comments are culling targets because they bloat agent context and the repo wants intent-only annotation.

## Rules (from the ticket)

- Every comment: at most one line, high-level intent only. Delete aggressively when the code speaks for itself.
- Ticket references collapse to a single subsequent line: `// @see #123 #456`.
- JSDoc blocks collapse to single-line `/** intent */` (keeps editor tooling); `@see` line follows as a `//` comment.
- Directive comments (`eslint-disable`, `@ts-expect-error`, `prettier-ignore`, …) stay verbatim — they are functional; trailing explanations after `--` may go.
- Inline trailing comments: delete unless they explain non-obvious intent (magic values, workarounds); never exceed one line.
- No code changes, no new comments. Test fixtures (e.g. `sample.html`) are data, not documentation — untouched.

## Scope

- `apps/{server,client,shared,migrations}` sources + tests (~309 TS/TSX files with comments)
- `scripts/*.ts`
- `eslint.config.js`, `.github/workflows/*.yml`, `Dockerfile`, `docker-compose.*.yml`, `scripts/*.sh`, `workspace.sh`
- Excluded: `docs/` (prose, not comments), build output, HTML test fixture.

## Execution

1. First pass: dense-list batching (4 agents) — 3 completed their lists; a prompt bug sent the 4th repo-wide with self-coordinated collision avoidance.
2. Second pass (adopted per review): directory-partitioned agents — client/server/main/test, shared, migrations, e2e, scripts+configs — each proving its own scope clean (no block continuations, no multi-line blocks, `//` runs only intent+`@see` pairs).
3. Damage repair from agent errors: 4 duplicated consts, 2 deleted type properties (`JudgeLabel.better`, `HelpfulnessCaseResult.blockCarriesId`), one load-bearing `/* keep '' */` empty-catch marker restored, indent fixes.
4. Verify: `npm run ci` exit 0; `npm run test:e2e` 60/60 (mobile+desktop).
5. Result: 324 files, net −5,283 lines; 1,086 `@see` ticket references kept.
6. Ship: branch `chore/tv/364-comment-cull`, PR closes #364.
