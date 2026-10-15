# Workflow — Standard process for any work larger than a tweak

## Scope

Any piece of work larger than a tweak (new feature, refactor, infra change, multi-file fix) follows this process end to end.

A **tweak** is a trivial one-line fix, typo, or config nudge. Tweaks skip steps 1–3 but still require verification (step 5) and a PR (step 6).

Work organized as an epic additionally follows the **Epics** section at the end of this doc.

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

Once the work is ready for review — implemented, verified, CI green — move the plan doc to `docs/done/` (create the directory if it does not exist), then push the branch and open a PR against `main` with a short summary and the plan doc linked. The archive rides the PR: reviewers see the decision log, and a merge needs no follow-up archive commit. Fixes that come in after this point — review comments, merge conflicts — are updates to the PR, not a reopening of the plan.

## Epics

An **epic** is a set of related tickets shipped as one body of work. It is represented on GitHub by an umbrella issue labelled `epic` whose body lists the slice tickets; each slice cites `Epic: #<n>` in its body (see #251 for the shape).

1. **Umbrella ticket**: create the epic issue first, label it `epic`, and list the slice tickets in its body. Slices are ordinary tickets and follow the standard process (steps 1–7) with the modifications below.
2. **Branch**: create `epic/<n>-<summary>` from `main` (e.g. `epic/251-workspace`), where `<n>` is the epic ticket number.
3. **Plan doc**: the epic has its own plan doc, `docs/plan-<n>-<summary>.md`, with the same minimum content as a ticket plan doc. It lives on the **epic branch** and is always updated there — it is the decision log for the whole epic.
4. **Slice branches and PRs**: cut slice branches from the **epic branch** (not `main`), named per the standard convention. Slice PRs target the epic branch instead of `main`; a slice's plan doc is archived to `docs/done/` when the slice is ready for review, riding the slice PR.
5. **Cross-merges**: ticket branches may merge each other as needed — a slice that depends on another can merge that branch directly.
6. **Ship the epic**: once all slices are done, move the epic plan doc to `docs/done/` (same ready-for-review trigger as the standard workflow) and open **one big PR from the epic branch to `main`**, linking that doc. The full quality gate (`npm run ci`) runs on it like any other PR.

Everything else follows the standard process unchanged.
