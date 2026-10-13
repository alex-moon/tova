# Tova

Tova is a chat application with authenticated users, persistent MongoDB-backed chat sessions, and an intelligent router that races a fixed roster of models across multiple providers per turn — with a built-in tool-calling agent, an asset library, and per-user MCP extensions. Think of it as an application layer that puts model routing, tools, and storage behind a single chat product.

## Features

- **Intelligent Routing**: A fixed model roster (MongoDB `modelroster`) is ranked by measured TTFT and price; each turn hedges the chosen model across its serverless providers (DeepInfra + Fireworks) and keeps the first to respond.
- **Tool-calling Agent**: Chat runs through a Mastra agent loop with optional `web_search` (Brave Search API), the current time (`current_datetime`), user-scoped MCP server tools, and asset tools (`list_files`, `read_file`, `generate_file`). The SSE stream emits structured `tool` call/result events.
- **Persistent Chat**: Session-based chat history in MongoDB, with per-message routing `metrics` and user thumbs up/down feedback, followup suggestions, and auto-generated session titles.
- **Asset Library**: File uploads to DigitalOcean Spaces with presigned uploads/downloads, text extraction for documents, and per-message attachments.
- **MCP Servers**: Per-user MCP server CRUD; auth tokens are encrypted at rest with AES-256-GCM (`MCP_ENCRYPTION_KEY`).
- **Optional Observability**: LangSmith tracing of every LLM call (agent → step → inference → llm) when configured.
- **Secure Auth**: JWT-based authentication with HTTP-only cookies, plus Google sign-in.
- **Modern UI**: React chat interface with drag-drop asset panel and markdown rendering.

Optional features degrade gracefully: unset env keys simply disable the feature (no search tool, no asset library, no tracing), plain chat keeps working.

## Local Development (recommended)

Backing services (MongoDB) run in Docker Compose; the backend and frontend run directly on the host.

### Prerequisites

- Node.js (v22+) and npm
- Docker with the Compose plugin (for MongoDB only)
- Provider API keys: DeepInfra + Fireworks (chat roster racing) and Groq (auxiliary calls: titles, followups, metrics classification), plus the Google OAuth credentials described below

### Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment** — copy `.env.example` to `.env` in the repo root (it is the canonical list). Required: `GROQ_API_KEY`, `JWT_SECRET`, `MONGODB_URL` (full Mongo connection string; Atlas uses the `mongodb+srv://` scheme) or `MONGODB_PASSWORD` (dev fallback assembled from it), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`. Optional per feature: `BRAVE_SEARCH_API_KEY` (web search tool), `DO_SPACES_KEY`/`DO_SPACES_SECRET`/`DO_SPACES_BUCKET`/`DO_SPACES_REGION` (asset library), `MCP_ENCRYPTION_KEY` (MCP servers with auth headers), `LANGSMITH_API_KEY` + `LANGCHAIN_PROJECT` (tracing), `ADMIN_PASSWORD` (default `admin`), `GOOGLE_SAFE_BROWSING_API_KEY` (safe link check for `fetch_url`; `GOOGLE_API_KEY` also accepted).
3. **Start the stack** (MongoDB in Docker)

   ```bash
   npm run stack:up
   ```

4. **Run migrations** (seed admin user, email `formsatz@gmail.com`)

   ```bash
   npm run db:migrate
   ```

5. **Start the backend** (terminal 1)

   ```bash
   npm run dev:server
   ```

6. **Start the frontend** (terminal 2)

   ```bash
   npm run dev:client
   ```

7. **Test end to end**
   - Open http://localhost:5173
   - Log in with the admin email from step 4. Password: `ADMIN_PASSWORD` from `.env` (default `admin`).
   - Send a chat message. You get a streamed reply from the routed model.

Admin password comes from `ADMIN_PASSWORD` in `.env` (defaults to `admin` — change it before seeding a shared environment). The seeded user (`formsatz@gmail.com`, hardcoded in migrations) has `role: admin` and the `routing` permission. New users do not have the `routing` permission, so they cannot use the model router until it is granted.

### Google sign-in

Required: set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in `.env` (see `/.env.example` for where to get them). "Continue with Google" is unavailable while any of the three is unset. Register a Google OAuth client (Web application) with authorized redirect URI `http://localhost:5173/api/auth/google/callback` for dev and `https://<prod-host>/api/auth/google/callback` for prod. If the email already exists, the Google identity is linked to that user; otherwise a new user is created (without the `routing` permission).

### Individual commands

| Command                                  | What it does                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm install`                            | Install all workspace dependencies (npm workspaces)                                          |
| `npm run stack:up` / `stack:down`        | Start/stop the Dockerized MongoDB backing service                                            |
| `npm run db:migrate` / `db:migrate:down` | Run/undo DB migrations (`mongo-migrate-ts`, `apps/migrations/`)                              |
| `npm run db:dump`                        | `mongodump` from `MONGODB_DUMP_URL` into a `data/db-dumps/` tarball                          |
| `npm run db:drop`                        | Drop the database in `MONGODB_URL` (localhost-gated, see below)                              |
| `npm run db:restore`                     | Restore the latest `data/db-dumps/` tarball into `MONGODB_URL` (gated)                       |
| `npm run db:sync`                        | Dump from `MONGODB_DUMP_URL`, drop, and restore into `MONGODB_URL`                           |
| `npm run db:password`                    | Reset all passwords to `password` and all PATs to `tova_pat_TEST` (gated)                    |
| `npm run dev`                            | Run backend + frontend together                                                              |
| `npm run dev:server`                     | Run backend only (watch mode)                                                                |
| `npm run dev:client`                     | Run frontend only (Vite dev server)                                                          |
| `npm run build`                          | Compile backend TypeScript to `dist/`                                                        |
| `npm run build:client`                   | Build the frontend bundle                                                                    |
| `npm start`                              | Start the built backend from `dist/main.js`                                                  |
| `npm test`                               | Run the backend Jest suite (also run via `test:server`)                                      |
| `npm run test:e2e`                       | Run the Playwright e2e suite (`e2e/`)                                                        |
| `npm run lint` / `lint:fix`              | ESLint check / auto-fix over `apps/`; `fix` does both fixes                                  |
| `npm run format` / `format:fix`          | Prettier check / write over the repo (`format:check` is an alias)                            |
| `npm run typecheck`                      | TypeScript, no emit                                                                          |
| `npm run ci:server` / `ci:client`        | Granular gates: server = lint, format, typecheck, tests; client = lint, format, tests, build |
| `npm run ci`                             | Full gate: `ci:client` then `ci:server`                                                      |
| `npm run deploy`                         | Deploy the live stack over SSH (see below)                                                   |

`db:drop`, `db:restore`, `db:sync`, and `db:password` are destructive against `MONGODB_URL`, so they refuse to run if that URL points anywhere except `localhost`/`127.0.0.1` unless you append `-- --i-know-this-is-dangerous` (e.g. `npm run db:sync -- --i-know-this-is-dangerous`). Dumps land in `data/db-dumps/` (git-ignored). These npm scripts wrap MongoDB's `mongodump`/`mongorestore` (Database Tools) — use the scripts, not the raw binaries.

## Live (all-in-Docker) Workflow

`npm run deploy` pushes and runs the full containerized stack on the configured server via `scripts/deploy.sh`: it SSHes to `SSH_HOST` (default baked into the script, override with e.g. `SSH_HOST=user@host npm run deploy`) and sets the app up under `/opt/tova`, where `.env` (modeled on `.env.example`) is loaded by `docker-compose.live.yml`. The compose file runs MongoDB, backend, and frontend as one self-contained deployment. On the host, the backend is reachable at port `15000` (container port 5000) and the frontend at port `15173` (container port 4173); the deployed Google OAuth callback must therefore use the frontend host port.

`docker-compose.local.yml` is the MongoDB-only file used by the local workflow above.

## Routing & Inference

Routing runs a fixed, owner-locked **model roster** with per-turn **hedged provider racing** (#232). There is no tier classifier and no ε-exploration.

1. **Roster pick** — the roster lives in the MongoDB `modelroster` collection (one document per model, each carrying a nested `providers[]` list). Models are ranked by a weighted score `score = TTFT × price penalty` (lower is better): the rolling average time-to-first-token recorded per (model, provider) against a linear price multiplier, so price only breaks near-ties. The lowest-scoring eligible model is the primary. Image turns restrict the roster to `vision: true` models.
2. **Hedged race** — every turn fires the primary model on **both** of its serverless providers (DeepInfra + Fireworks) concurrently; the first to yield its first token wins and the loser is aborted. The winner's TTFT is recorded against (model, provider), feeding the next turn's weighted pick. A provider that fails transiently cools off (short TTL for endpoint overload, longer for a broken endpoint).

If the primary fails on every provider, routing falls through to the next roster model (bounded attempts), reusing provider-error classification for transient vs. hard failures. An empty roster fails loudly (the all-disabled message) rather than falling back silently.

Inference runs through Mastra connectors across multiple providers. Chat responses carry `routing` metadata, and the SSE stream emits `meta`, `tool` (call and result), `delta`, `error`, and `done` events. See `docs/overview.md` for the product-level detail.

## Optional Integrations

- **Web search** (`BRAVE_SEARCH_API_KEY`): enables the agent's `web_search` tool. Unset → no search tool at all.
- **Safe link checking** (`GOOGLE_SAFE_BROWSING_API_KEY`, falls back to `GOOGLE_API_KEY`): screens every URL the agent fetches via `fetch_url` (including redirect targets) against Google Safe Browsing's threatMatches endpoint, with a 24h domain-level cache. Unset → `fetch_url` works unchanged, unchecked (issue #120).
- **Assets** (`DO_SPACES_*`): DigitalOcean Spaces storage with presigned PUT/GET; objects stay private. Unset → the asset library is disabled.
- **MCP servers** (`MCP_ENCRYPTION_KEY`): users register personal MCP servers; auth headers are encrypted at rest. Unset → MCP servers with auth headers cannot be added.
- **Tracing** (`LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`): hierarchical LangSmith traces of every LLM call. Unset → nothing is exported.

## Implementation Pointers

- Backend entry: `apps/server/src/main.ts`
- Server app bootstrap: `apps/server/src/index.ts`
- Routes: `apps/server/src/routes/` (chat, auth, assets, mcpServers, feedback, profile, admin)
- Services: `apps/server/src/services/` (roster config + provider racing, Mastra agent + connectors, search/MCP/assets, metrics)
- Frontend app: `apps/client/src/App.tsx`
- Product overview: `docs/overview.md`
- Status and delivery log: `docs/progress.md` (static; open work is tracked in GitHub issues)
