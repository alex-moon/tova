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
- `docs/progress.md`: the delivery log and current status snapshot (packet system is closed; no outstanding local tasks)
- `docs/plan.md`: a closure note for the retired packet backlog

### Working rules for agents

- All new planning and task tracking happens on GitHub (`alex-moon/tova`): use issues for open work and pull requests for changes. Do not recreate local queue or packet files.
- Prefer `docs/progress.md` for historical delivery notes; it is a static log, not a live tracker.
- The repo is not a git-hygiene surface: only commit when explicitly asked.

### Code quality commands

Run these before finishing any code change:

- `npm run lint` — ESLint (TypeScript rules + Prettier rules) over `src/` and `migrations/`. Must pass with 0 errors. Use `npm run lint:fix` to auto-fix.
- `npm run typecheck` — TypeScript; must pass.
- `npm test` — backend Jest suite; must pass.
- `npm run format` / `npm run format:check` — Prettier over the repo (config in `.prettierrc`). Do not hand-format; let these run.

After changing frontend code, also run `npm --prefix src/client run lint`. Per-app shortcut scripts: `lint:server` / `format:server` / `test:server`, and `lint:client` / `format:client` / `test:client` (client tests use `vitest`, config in `src/client/vite.config.ts`).

Style: Prettier settings in `.prettierrc` (single quotes, trailing commas, 100 print width). Rules live in the root `eslint.config.js`.

- `npm run ci` — runs everything in sequence: server lint, format check, typecheck, server tests, client lint, client format check, client tests, client build. Fails at the first error. Run this as the final gate for any code change.
