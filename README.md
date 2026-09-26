# Tova

Tova is a chat application with authenticated users, persistent MongoDB-backed chat sessions, and an intelligent router that picks the best model for each prompt from eligible multi-provider model pools — with a built-in tool-calling agent, an asset library, and per-user MCP extensions. Think of it as an application layer that puts model routing, tools, and storage behind a single chat product.

## Features

- **Intelligent Routing**: Model pools (not fixed pairs) are resolved from MongoDB per tier (`small`, `large`, `guard`); a context-aware guard-model classifier picks the tier — large by default, small only for trivially conversational turns — and feedback weighting re-orders the pool.
- **Tool-calling Agent**: Chat runs through a Mastra agent loop with optional `web_search` (Brave Search API), the current time (`current_datetime`), user-scoped MCP server tools, and asset tools (`list_files`, `read_file`, `generate_file`). The SSE stream emits structured `tool` call/result events.
- **Persistent Chat**: Session-based chat history in MongoDB, with per-message routing `metrics` and feedback-driven model fit statistics, followup suggestions, and auto-generated session titles.
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
- Provider API keys: Groq (routing/classifier) and the Google OAuth credentials described below

### Setup

1. **Install dependencies**

   ```bash
   npm run install:all
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

| Command                                  | What it does                                                         |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `npm install`                            | Install root and client dependencies (`postinstall` adds the client) |
| `npm run install:all`                    | Explicit form of the above                                           |
| `npm run stack:up` / `stack:down`        | Start/stop the Dockerized MongoDB backing service                    |
| `npm run db:migrate` / `db:migrate:down` | Run/undo DB migrations (`mongo-migrate-ts`, `migrations/`)           |
| `npm run dev`                            | Run backend + frontend together                                      |
| `npm run dev:server`                     | Run backend only (watch mode)                                        |
| `npm run dev:client`                     | Run frontend only (Vite dev server)                                  |
| `npm run build`                          | Compile backend TypeScript to `dist/`                                |
| `npm run build:client`                   | Build the frontend bundle                                            |
| `npm start`                              | Start the built backend from `dist/index.js`                         |
| `npm test`                               | Run the backend Jest suite (also run via `test:server`)              |
| `npm run test:e2e`                       | Run the Playwright e2e suite (`e2e/`)                                |
| `npm run lint` / `lint:fix`              | ESLint over `src/` and `migrations/`; `fix` lint-fixes + formats     |
| `npm run format` / `format:check`        | Prettier over the repo                                               |
| `npm run typecheck`                      | TypeScript, no emit                                                  |
| `npm run ci`                             | Full gate: lint, format, typecheck, tests, client checks + build     |
| `npm run deploy`                         | Deploy the live stack over SSH (see below)                           |

## Live (all-in-Docker) Workflow

`npm run deploy` pushes and runs the full containerized stack on the configured server via `scripts/deploy.sh`: it SSHes to `SSH_HOST` (default baked into the script, override with e.g. `SSH_HOST=user@host npm run deploy`) and sets the app up under `/opt/tova`, where `.env` (modeled on `.env.example`) is loaded by `docker-compose.live.yml`. The compose file runs MongoDB, backend, and frontend as one self-contained deployment. On the host, the backend is reachable at port `15000` (container port 5000) and the frontend at port `15173` (container port 4173); the deployed Google OAuth callback must therefore use the frontend host port.

`docker-compose.local.yml` is the MongoDB-only file used by the local workflow above.

## Routing & Inference

Routing picks a tier, then a model:

1. **Guard classifier** — every text turn is classified by a guard-tier model call that sees the recent conversation and replies with JSON category votes (`reasoning`/`code`/`emotional`/`creative`); any "yes" routes large, all "no" routes small, and every failure mode (empty, unparseable, thrown) falls back to the large tier (#169). Image turns skip the classifier and route to the large vision pool (#115).
2. **Pool pick** — each tier resolves to an eligible pool of models from the MongoDB `providerroutings` collection (managed via admin routes; env vars `ROUTER_SMALL_MODEL`/`ROUTER_LARGE_MODEL` are the fallback when the DB has no rows). A single-model pool is deterministic; a multi-model pool uses ε-random exploration (`ROUTER_EPSILON`) so per-model feedback can accrue.

Per-band/model up/down feedback (`/api/feedback`) is aggregated into fit weights; when a pool's leader exceeds the `FEEDBACK_FLIP_RATIO` margin, it is forced into the pick, otherwise the pool is ε-shuffled. Empty pools fail loudly rather than falling back silently.

Inference runs through Mastra connectors across multiple providers; per #94, completions default to DeepInfra models, while the routing classifier's guard model rides a Groq small-tier model. Chat responses carry `routing` metadata, and the SSE stream emits `meta`, `tool` (call and result), `delta`, `error`, and `done` events. See `docs/overview.md` for the product-level detail.

## Optional Integrations

- **Web search** (`BRAVE_SEARCH_API_KEY`): enables the agent's `web_search` tool. Unset → no search tool at all.
- **Safe link checking** (`GOOGLE_SAFE_BROWSING_API_KEY`, falls back to `GOOGLE_API_KEY`): screens every URL the agent fetches via `fetch_url` (including redirect targets) against Google Safe Browsing's threatMatches endpoint, with a 24h domain-level cache. Unset → `fetch_url` works unchanged, unchecked (issue #120).
- **Assets** (`DO_SPACES_*`): DigitalOcean Spaces storage with presigned PUT/GET; objects stay private. Unset → the asset library is disabled.
- **MCP servers** (`MCP_ENCRYPTION_KEY`): users register personal MCP servers; auth headers are encrypted at rest. Unset → MCP servers with auth headers cannot be added.
- **Tracing** (`LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`): hierarchical LangSmith traces of every LLM call. Unset → nothing is exported.

## Implementation Pointers

- Root backend entry: `src/index.ts`
- Server app bootstrap: `src/server/index.ts`
- Routes: `src/server/routes/` (chat, auth, assets, mcpServers, feedback, profile, admin)
- Services: `src/server/services/` (router/model config, Mastra agent + connectors, search/MCP/assets, metrics)
- Frontend app: `src/client/src/App.tsx`
- Product overview: `docs/overview.md`
- Status and delivery log: `docs/progress.md` (static; open work is tracked in GitHub issues)
