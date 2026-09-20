## Agent Collaboration Guide

This repository keeps shared, agent-agnostic project coordination documents in `docs/`.

### Project intent

`Tova` is building a chat application with:

- authenticated users
- persistent chat sessions stored in MongoDB
- an intelligent router that selects models based on prompt complexity
- a React frontend served through a unified local development experience

In short: it is aiming to be an application-layer service for inference providers with a built-in chat product.

### Documentation structure

- `docs/overview.md`: a high-level summary of the overall intent
- `docs/workflow.md`: the standard process for new work (see "Standard workflow" below)
- `docs/plan-<ticket>-<summary>.md`: plan docs for in-flight work; archived to `docs/done/` after merge
- `docs/progress.md`: static delivery log; history lives here, not a live tracker

### Working rules for agents

- All new planning and task tracking happens on GitHub (`alex-moon/tova`): use issues for open work and pull requests for changes. Do not recreate local queue or packet files.
- Prefer `docs/progress.md` for historical delivery notes; it is a static log, not a live tracker.
- The repo is not a git-hygiene surface: only commit when explicitly asked.

### Standard workflow for any work larger than a tweak

Follow `docs/workflow.md` as the specification. In short, every piece of work larger than a tweak goes through these steps in order:

1. **Ticket** — create a GitHub issue in `alex-moon/tova`; if a matching one already exists, use it instead of duplicating.
2. **Branch** — create a branch named `<feat or fix>/tv/<ticket number>-<one or two word summary>` (e.g. `feat/tv/123-deploy-script`).
3. **Plan** — document the plan in `docs/` following the specification in `docs/workflow.md`.
4. **Implement** — complete the work, keeping the plan doc updated as decisions and scope change.
5. **Verify** — run lint, format, test, and (where possible) e2e; fix any issues. See "Code quality commands" below.
6. **Ship** — push the branch and open a PR with a short summary.
7. **Archive** — move the plan doc to `docs/done/`.

Tweaks (trivial one-line fixes, typos, config nudges) may skip steps 1–3 but still require verification and a PR.

### Cleanup scope policy

Do cleanup-as-we-go, but only with explicit confirmation:

- If the current ticket/PR exposes an issue in its own scope (e.g. a PR review comment), fixing that issue broadly — related files sharing the same defect — is defensible and fine.
- Do not silently expand scope by default. If you notice a neighbouring issue worth fixing, raise it as a suggestion in your report/PR comment and wait for the user to confirm.
- Never use a ticket as cover for drive-by refactors of untouched subsystems.

### Model routing decisions

Any change to routing policy (tier boundaries, guard classification, pool defaults) must be evidence-first, not instinct:

- Compare candidate models directly with the one-off eval script (`scripts/eval-model-compare.ts`): `npx tsx scripts/eval-model-compare.ts "<prompt>" --models deepinfra/Qwen/Qwen3-14B,groq/openai/gpt-oss-20b`. It runs a single prompt through the existing agent on each model, printing answers side by side. The admin view's "Compare" tab does the exact same thing in the browser (it shares the same server code).
- Read LangSmith traces liberally before judging a routing change (read-only): project `tova-dev` via the `LANGCHAIN_*` credentials in `.env`. Real traces are the best evidence for which tier a conversational prompt belongs in — e.g. ticket #129 was diagnosed entirely from a trace showing the guard model returning empty replies.

### Local MongoDB

A local MongoDB is available at `mongodb://localhost:27017/tova` at any time. If it is not running, start the stack with `npm run stack:up`.

There is no `mongosh` binary in this environment (yet). To query or mutate the local database, write a small script with `scripts/mongo.ts` (helper built on `mongodb` driver, async by default):

- `npx tsx scripts/mongo.ts <js-expression>` — evaluates a snippet with `db` bound to the `tova` database, prints the result. Examples: `npx tsx scripts/mongo.ts "await db.listCollections().toArray()"`, `npx tsx scripts/mongo.ts "await db.collection('sessions').countDocuments()"`.
- Prefer small, explicit snippets; this is a debugging tool, not an ORM.

### Code quality gate

`npm run ci` is the single gate for any code change. It runs everything in sequence (server lint, format check, typecheck, server tests, client lint, client format check, client tests, client build), fails at the first error, and is mirrored by the CI workflow that gates merges to `main`. Run it as the final step before finishing any change; it must pass with exit code 0. Per-step commands below are only for iterating on a single failure without re-running the whole gate:

- `npm run lint` — ESLint (TypeScript rules + Prettier rules) over `src/` and `migrations/`. Use `npm run lint:fix` to auto-fix.
- `npm run typecheck` — TypeScript.
- `npm test` — backend Jest suite.
- `npm run format` / `npm run format:check` — Prettier over the repo (config in `.prettierrc`). Do not hand-format; let these run.

After changing frontend code, iterate with `npm --prefix src/client run lint` and the client shortcut scripts: `lint:client` / `format:client` / `test:client` (vitest, config in `src/client/vite.config.ts`).

Style: Prettier settings in `.prettierrc` (single quotes, trailing commas, 100 print width). Rules live in the root `eslint.config.js`.
