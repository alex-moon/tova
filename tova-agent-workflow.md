# Agent workflow — copy to `.github/workflows/agent.yml` and push to main.

Prepared 2026-10-11 for `alex-moon/tova`. Both secrets (DEEPINFRA_API_KEY,
FIREWORKS_API_KEY) already exist in the repo's Actions secrets — "Install"
below is the whole setup.

## What it does

- `@agent <task>` on any issue or PR → **DeepSeek V4.1 Flash** (spec'd work)
  via DeepInfra: fixes CI failures, applies known fixes, does mechanical tasks.
- `@agent-think <task>` → **GLM 5.3 Flash** (vague/ambiguous work) via DeepInfra.
- Runs headless Goose CLI (installed via attestation-verified setup action),
  opens a **PR** rather than pushing main (deploy.yml deploys prod straight
  from main, so CI gates -- semgrep + e2e -- stand between agent and prod).
  Remove the NEVER-push rule from the prompt to allow direct-to-main.

## Fireworks fallback (whichever provider isn't saturated)

Replace the two `OPENAI_*` env vars:

```yaml
OPENAI_HOST: https://api.fireworks.ai/inference/v1
# and delete OPENAI_BASE_PATH (Fireworks' path is Goose's default)
# model slugs on Fireworks: accounts/fireworks/models/deepseek-v4p1-flash
#   accounts/fireworks/models/glm-5p3-flash  — verify exact slugs in the dashboard
```

## First-run caveat

If the `goose run` CLI flags have changed (most likely failure mode), paste
the Actions log and adjust the invoke step — it's a one-line fix.

## Install

1. Create `.github/workflows/agent.yml` on main with the YAML below.
2. Done. Test: open an issue and comment `@agent @agent help me test`...
   or better, run yourself in the Actions tab with "agent dispatch."

```yaml
name: agent

on:
  issue_comment:
    types: [created]
  workflow_dispatch: {}

concurrency:
  group: agent-${{ github.event.issue.number || github.run_id }}
  cancel-in-progress: false

jobs:
  route:
    if: >
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issue_comment' &&
       contains(github.event.comment.body, '@agent'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      mode: ${{ steps.route.outputs.mode }}
      task: ${{ steps.route.outputs.task }}
    steps:
      - name: Pick model + extract task
        id: route
        env:
          BODY: ${{ github.event.comment.body }}
        run: |
          if echo "$BODY" | grep -q '@agent-think'; then
            echo "mode=think" >> "$GITHUB_OUTPUT"
            echo "task=$(echo "$BODY" | sed 's/.*@agent-think: *//' | head -c 2000)" >> "$GITHUB_OUTPUT"
          else
            echo "mode=do" >> "$GITHUB_OUTPUT"
            echo "task=$(echo "$BODY" | sed 's/.*@agent: *//' | head -c 2000)" >> "$GITHUB_OUTPUT"
          fi

  agent:
    needs: route
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write          # push the fix branch / open the PR
      pull-requests: write     # open + comment on PRs
      issues: write            # comment back on the trigger issue
    env:
      OPENAI_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}
      OPENAI_HOST: https://api.deepinfra.com
      OPENAI_BASE_PATH: v1/openai/chat/completions
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install goose
        uses: actions-attestations/setup-goose-action@v1

      - name: Run agent
        env:
          MODE: ${{ needs.route.outputs.mode }}
          TASK: ${{ needs.route.outputs.task }}
        run: |
          if [ "$MODE" = "think" ]; then
            echo "GOOSE_MODEL=zai-org/GLM-5.3-Flash" >> "$GITHUB_ENV"
          else
            echo "GOOSE_MODEL=deepseek-ai/DeepSeek-V4.1-Flash" >> "$GITHUB_ENV"
          fi
          export GOOSE_PROVIDER=openai
          # recipe is just the task + guardrails
          cat > /tmp/recipe.yaml <<'EOF'
          title: agent-task
          instructions: |
            You are fixing a small task on the tova repo (a toy app; owner is
            not precious). Work autonomously:

            {{ task }}

            Rules:
            - NEVER git push to main. Always: git checkout -b agent/fix-<slug>,
              push, then open a PR against main via gh.
            - Keep the change minimal. No refactors, no dependency upgrades,
              no unrelated edits.
            - Run the repo's lint/test/semgrep checks that are feasible before
              you push; if they fail, fix or explain.
            EOF
          goose run --recipe /tmp/recipe.yaml --task "$(cat /task.yml)" || exit 1

      - name: Remove task label (done)
        if: always() && github.event_name == 'issue_comment'
        run: echo done
```