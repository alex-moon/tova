# Agent workflow

The live workflow is `.github/workflows/agent.yml` — this doc records how it
works and how to operate it. The workflow file is the source of truth for
behavior; do not copy YAML back into this doc (a stale embedded copy lived
here until #295 and drifted).

## What it does

- Comment `@agent <task>` on any issue or PR, open a new issue whose **body**
  starts with `@agent`, or run manually from the Actions tab ("agent
  dispatch" with a prompt).
- `@agent <task>` → **DeepSeek V4.1 Flash** (spec'd work: CI fixes, mechanical
  tasks) via DeepInfra. `@agent-think <task>` → **GLM 5.3 Flash**
  (vague/ambiguous work: design, refactors) via DeepInfra.
- **Context is auto-gathered before the agent runs** (`Build task + pick model`
  step): the instruction, PR/issue state (branches, merge state, failing CI
  checks), thread comments, and any `#NNN` tickets referenced in the thread
  (title + body each, capped). The agent has `gh` for anything deeper.
- Runs headless Goose CLI, and **opens a PR rather than pushing main** (the
  deploy workflow deploys prod straight from main, so CI gates stand between
  the agent and prod). On a PR trigger, it pushes to the PR's existing branch
  instead of opening a duplicate PR.
- Working rules tell the agent to run `npm run ci` locally before opening its
  PR, and to read real failed logs (`gh run list` → `gh run view <id>
--log-failed`) when the task mentions CI failures.

## Secrets

`DEEPINFRA_API_KEY` and `FIREWORKS_API_KEY` exist in the repo's Actions
secrets. `GITHUB_TOKEN` is the workflow token.

## Fireworks fallback (whichever provider isn't saturated)

Replace three env lines in the "Run goose" step:

```yaml
OPENAI_HOST: https://api.fireworks.ai
OPENAI_BASE_PATH: inference/v1/chat/completions
OPENAI_API_KEY: ${{ secrets.FIREWORKS_API_KEY }}
```

(Fireworks model slugs differ — check the dashboard.)

## First-run caveat

If the `goose run` CLI flags have changed (most likely failure mode), paste
the Actions log and adjust the invoke step — it's a one-line fix.
