## Agent Collaboration Guide

This repository keeps shared, agent-agnostic project coordination documents in `docs/`.

### Project intent

`Tova` is building a Groq-focused chat application with:

- authenticated users
- persistent chat sessions stored in MongoDB
- an intelligent router that selects Groq models based on prompt complexity
- a React frontend served through a unified local development experience

In short: it is aiming to be an application-layer “Heroku for Groq” with a built-in chat product.

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

### Local MongoDB

A local MongoDB is available at `mongodb://localhost:27017/tova` at any time. If it is not running, start the stack with `npm run stack:up`.

There is no `mongosh` binary in this environment (yet). To query or mutate the local database, write a small script with `scripts/mongo.ts` (helper built on `mongodb` driver, async by default):

- `npx tsx scripts/mongo.ts <js-expression>` — evaluates a snippet with `db` bound to the `tova` database, prints the result. Examples: `npx tsx scripts/mongo.ts "await db.listCollections().toArray()"`, `npx tsx scripts/mongo.ts "await db.collection('sessions').countDocuments()"`.
- Prefer small, explicit snippets; this is a debugging tool, not an ORM.

### Code quality commands

Run these before finishing any code change:

- `npm run lint` — ESLint (TypeScript rules + Prettier rules) over `src/` and `migrations/`. Must pass with 0 errors. Use `npm run lint:fix` to auto-fix.
- `npm run typecheck` — TypeScript; must pass.
- `npm test` — backend Jest suite; must pass.
- `npm run format` / `npm run format:check` — Prettier over the repo (config in `.prettierrc`). Do not hand-format; let these run.

After changing frontend code, also run `npm --prefix src/client run lint`. Per-app shortcut scripts: `lint:server` / `format:server` / `test:server`, and `lint:client` / `format:client` / `test:client` (client tests use `vitest`, config in `src/client/vite.config.ts`).

Style: Prettier settings in `.prettierrc` (single quotes, trailing commas, 100 print width). Rules live in the root `eslint.config.js`.

- `npm run ci` — runs everything in sequence: server lint, format check, typecheck, server tests, client lint, client format check, client tests, client build. Fails at the first error. Run this as the final gate for any code change.
