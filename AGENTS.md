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

### Client UI work

When changing the React client (`apps/client`), the end user is assumed to be on a phone, not a desktop:

- **Mobile-first.** Design and verify for narrow viewports first; treat desktop as the enhancement, not the baseline. When a layout works on desktop but not mobile, it is broken.
- **Every route is a phone surface — including `/admin`.** The owner uses the admin view on mobile as a deliberate quick-view for the desktop-first tools it fronts (LangSmith traces, Grafana logs); that is why those tabs live inside Tova at all. There is no desktop-only exemption. Density is fine, horizontal overflow without an affordance is not.
- **Always use the `playwright-cli` skill** to render and inspect UI changes in a real browser before calling the work done. Do not judge visual/UX work from code alone.
- **Verify at a phone viewport, not the default.** Render at ~375–390px wide. Playwright's default (1280×720) is a desktop lie: it will happily show a table that is clipped to three columns on a phone. Check the responsive `e2e/` suite (below) as the mechanical backstop.

These rules are behavioral policy, so they apply to every client change regardless of size; they do not replace the "Code quality gate" below.

#### Running the client locally

- Start the stack (Mongo + dev server + Vite): `npm run stack:up` then `npm run dev`; the client is at `http://localhost:5173`.
- **Reset to a known login any time with `npm run db:password`**, then sign in as any seeded user with the password `password`. This is the owner's local workflow and the intended fixture path — do not register-and-promote accounts instead (that is what PATs replaced, #184).
- The responsive end-to-end suite is `npm run test:e2e` (`e2e/playwright.config.ts`). It runs every spec in both a `mobile` (375×667, touch) and a `desktop` project. As of #220 it is gated by CI when `apps/client/**` or `e2e/**` changes, and `e2e/responsive.spec.ts` asserts no route overflows horizontally at phone width. Locally, reset the DB first (`npm run db:password`) — the auth specs depend on the seeded fixture password `password`.

_No known client drift as of #220; this section is a standing slot for the next drift found._

### Model routing decisions

Any change to routing policy (tier boundaries, guard classification, pool defaults) must be evidence-first, not instinct:

- Compare candidate models directly with the one-off eval script (`scripts/eval-model-compare.ts`): `npx tsx scripts/eval-model-compare.ts "<prompt>" --models deepinfra/Qwen/Qwen3-14B,groq/openai/gpt-oss-20b`. It runs a single prompt through the existing agent on each model, printing answers side by side. The admin view's "Compare" tab does the exact same thing in the browser (it shares the same server code).
- Read LangSmith traces liberally before judging a routing change (read-only): project `tova-dev` via the `LANGCHAIN_*` credentials in `.env`. Real traces are the best evidence for which tier a conversational prompt belongs in — e.g. ticket #129 was diagnosed entirely from a trace showing the guard model returning empty replies.

### Admin API access

Admin API endpoints (`/api/admin/*`) accept a personal access token: generate one in the admin view's Access tab (it is shown once), have the owner paste it into `.env`, then send `Authorization: Bearer $TOVA_PAT`. Tokens are per-environment — `TOVA_PAT_LOCAL` for the local dev server, `TOVA_PAT` for the live deployment — and only authenticate against the Mongo DB they were created in. Tokens inherit the creator's live role and are revocable in the same tab. Do NOT register-and-Mongo-promote a user to act as admin — that path is exactly what PATs replaced (#184). Plain cookie-session login remains the browser flow.

### Local MongoDB

A local MongoDB is available at `mongodb://localhost:27017/tova` at any time. If it is not running, start the stack with `npm run stack:up`.

There is no `mongosh` binary in this environment (yet). To query or mutate the local database, write a small script with `scripts/mongo.ts` (helper built on `mongodb` driver, async by default):

- `npx tsx scripts/mongo.ts <js-expression>` — evaluates a snippet with `db` bound to the `tova` database, prints the result. Examples: `npx tsx scripts/mongo.ts "await db.listCollections().toArray()"`, `npx tsx scripts/mongo.ts "await db.collection('sessions').countDocuments()"`.
- Prefer small, explicit snippets; this is a debugging tool, not an ORM.

### Database snapshots as diagnostic aid

Take a live dump of production at any time to aid diagnostics (it is non-destructive and safe to run freely):

- `npm run db:dump` — dumps the production/Atlas cluster (`MONGODB_DUMP_URL` in `.env`) into a tarball under `data/db-dumps/` (git-ignored). `npm run db:sync` additionally drops and restores it into the local stack (`MONGODB_URL`) so you can interrogate real data locally; the destructive steps refuse to run against a non-localhost target without `-- --i-know-this-is-dangerous`.
- Prefer the sync-then-interrogate-locally route: run `npm run db:sync`, then use `scripts/mongo.ts` snippets against the local db.
- `npm run db:password` resets every user password to `password` and every PAT to the shared literal `tova_pat_TEST` (dropping the PAT unique index so they can share one digest) — a local fixture convenience, guarded like the other destructive commands. The shared PAT is not a valid app-issued token.

Reading the dump artifacts directly has a catch: they live under `data/`, which is `.gitignore`d, and the native search/read tools skip ignored files — they will report "not found" even though the file exists. Use CLI tools instead for these paths (e.g. `bash`-tool `tar -tzf data/db-dumps/<file>.tar.gz` to list contents, `rg` explicitly pointed at the path). Preferably, don't read the artifacts at all: load one into the local stack with `npm run db:restore -- --tarball data/db-dumps/<file>.tar.gz` and interrogate it with `scripts/mongo.ts` (the dump/restore payloads are also binary BSON, so text tools get little out of them anyway).

### Reading logs from Grafana Cloud (Loki)

Retained production logs live in Grafana Cloud (hosted Loki) and are readable directly with the `LOKI_*` credentials in `.env` — the same ones the admin logs view uses (`apps/server/src/services/lokiLogs.ts`). The token is both read- and write-scoped; `LOKI_URL` is the push URL and the query API lives on the same host.

- `npm run logs -- '<logql>' --since <window> --limit <n> [--raw] [--json]` — runs `scripts/loki.ts`. The query is a LogQL stream selector; `--since` accepts `30m`/`2h`/`24h`/`7d` (default `1h`); `--limit` defaults to 100; `--raw` drops timestamps, `--json` prints the raw Loki response. Default selector is `{job="tova"}`.
- Examples: `npm run logs -- --since 6h`, `npm run logs -- '{job="tova"} |= "GET /api"' --since 24h --raw`, `npm run logs -- '{service="backend"} |~ "error|fail"' --since 2h`.
- Pass the LogQL as a single quoted argument. Streams are `{job="tova"}` with a `service` label — `backend` (the app server) and `frontend`; query distinct values with the Loki `/loki/api/v1/label/service/values` API if unsure. Do NOT use `npx tsx` here — use the npm script (or `node node_modules/tsx/dist/cli.mjs scripts/loki.ts ...`), consistent with the other `scripts/`.

### Code quality gate

`npm run ci` is the single gate for any code change. It runs everything in sequence (server lint, format check, typecheck, server tests, client lint, client format check, client tests, client build), fails at the first error, and is mirrored by the CI workflow that gates merges to `main`. Run it as the final step before finishing any change; it must pass with exit code 0. Per-step commands below are only for iterating on a single failure without re-running the whole gate:

Naming convention: a bare verb **checks**; append `:fix` to **write**. So `lint`/`format` check, `lint:fix`/`format:fix` change files.

- `npm run lint` — ESLint (TypeScript rules + Prettier rules) over `apps/`. Use `npm run lint:fix` to auto-fix.
- `npm run typecheck` — TypeScript.
- `npm test` — backend Jest suite.
- `npm run format` — Prettier check over the repo (config in `.prettierrc`). Use `npm run format:fix` to write. (`format:check` is an alias of `format`.) Do not hand-format; let these run.

Iterate per side with the shortcut scripts: `ci:server` / `ci:client`, plus `lint:server` / `format:server` / `test:server` and `lint:client` / `format:client` / `test:client` (vitest, config in `apps/client/vite.config.ts`).

Style: Prettier settings in `.prettierrc` (single quotes, trailing commas, 100 print width). Rules live in the root `eslint.config.js`.
