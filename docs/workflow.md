# Workflow — Standard process for any work larger than a tweak

## Scope

Any piece of work larger than a tweak (new feature, refactor, infra change, multi-file fix) follows this process end to end.

A **tweak** is a trivial one-line fix, typo, or config nudge. Tweaks skip steps 1–3 but still require verification (step 5) and a PR (step 6).

## Steps

### 1. Ticket

Create a GitHub issue in `alex-moon/tova` describing the work. If an issue for this work already exists, use it — do not duplicate.

### 2. Branch

Create a branch from `main`:

```
<feat or fix>/tv/<ticket number>-<one or two word summary>
```

- `feat` or `fix` reflecting the nature of the change.
- `<ticket number>` is the number of the issue from step 1.
- Summary is one or two words, lowercase, hyphenated. Example: `feat/tv/42-deploy-page`.

### 3. Plan

Document the plan in a doc under `docs/` named `plan-<ticket number>-<summary>.md` (e.g. `docs/plan-42-deploy-page.md`) with at least:

- **Motivation**: why this work is needed (link to the GitHub issue).
- **Decisions**: key technical choices and trade-offs, updated as they are made.
- **Done**: checklist of the work, updated while implementing.
- **Follow-ups**: anything deliberately deferred (link to new GitHub issues if created).

Keep the doc updated in step 4 as decisions and scope change. Do not invent history: the doc should reflect only decisions actually made.

### 4. Implement

Complete the work on the branch. Commit as needed; keep the plan doc current.

### 5. Verify

Run lint, format, typecheck, and tests; run e2e where possible. Fix any issues. See the "Code quality commands" section in `AGENTS.md` for the exact commands (`npm run ci` is the final gate).

### 6. Ship

Push the branch and open a PR against `main` with a short summary and the plan doc linked.

### 7. Archive

Once the PR merges, move the plan doc to `docs/done/` (create the directory if it does not exist).
