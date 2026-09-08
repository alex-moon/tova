# Tova

Tova is an intelligent model router and chat interface for Groq LLMs. Think of it as "Heroku for Groq".

## Features

- **Intelligent Routing**: Automatically selects between small (Llama 3 8B) and large (Llama 3 70B) models based on query complexity.
- **Persistent Chat**: Session-based chat history stored in MongoDB.
- **Secure Auth**: JWT-based authentication with HTTP-only cookies.
- **Modern UI**: Semantic React-based chat interface.

## Local Development (recommended)

Backing services (MongoDB) run in Docker Compose; the backend and frontend run directly on the host.

### Prerequisites

- Node.js (v22+) and npm
- Docker with the Compose plugin (for MongoDB only)
- A Groq API key

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Configure environment** — create a `.env` file in the repo root.
   ```env
   PORT=5000
   MONGODB_URI=mongodb://localhost:27017/tova
   JWT_SECRET=your_secret_key
   GROQ_API_KEY=your_groq_api_key
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   GOOGLE_CALLBACK_URL=http://localhost:5173/api/auth/google/callback
   NODE_ENV=development
   ```
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
   - Send a chat message. You get a reply from a Groq model.

Admin password comes from `ADMIN_PASSWORD` in `.env` (defaults to `admin` — change it before seeding a shared environment). The seeded user (`formsatz@gmail.com`) has `role: admin` and the `routing` permission.

### Google sign-in

"Continue with Google" uses `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` from `.env`. Register a Google OAuth client (Web application) with authorized redirect URI `http://localhost:5173/api/auth/google/callback` for dev and `https://<prod-host>/api/auth/google/callback` for prod. If the email already exists, the Google identity is linked to that user; otherwise a new user is created. New users do not have the `routing` permission, so they cannot use the model router until it is granted.

### Individual commands

| Command                               | What it does                                               |
| ------------------------------------- | ---------------------------------------------------------- |
| `npm install`                         | Install root and client dependencies                       |
| `npm run install:all`                 | Same as `npm install` (explicit form)                      |
| `npm run stack` / `stack:down`        | Start/stop the Dockerized MongoDB backing service          |
| `npm run migrate` / `db:migrate:down` | Run/undo DB migrations (`mongo-migrate-ts`, `migrations/`) |
| `npm run dev`                         | Run backend + frontend together                            |
| `npm run dev:server`                  | Run backend only (watch mode)                              |
| `npm run dev:client`                  | Run frontend only (Vite dev server)                        |
| `npm run build`                       | Compile backend TypeScript to `dist/`                      |
| `npm run build:client`                | Build the frontend bundle                                  |
| `npm start`                           | Start the built backend from `dist/index.js`               |
| `npm test`                            | Run the backend Jest suite                                 |
| `npm run ci`                          | Full CI check: lint, format, typecheck, tests, build       |

## Live (all-in-Docker) Workflow

`docker-compose.live.yml` runs everything in containers: MongoDB, backend, and frontend, as a self-contained deployment.

```bash
JWT_SECRET=your_secret_key GROQ_API_KEY=your_key docker compose -f docker-compose.live.yml up
```

- Frontend: http://localhost:5173
- Backend: `localhost:5000` (container network: `mongodb://mongodb:27017/tova`)

`docker-compose.local.yml` is the MongoDB-only file used by the local workflow above. If you change dev behavior in either compose file, check the other — they share the `mongodb_data` semantics but serve different purposes.

## Model Routing Contract

Every chat request (streaming and non-streaming) returns or emits `routing: { model, reason }`. Routing is decided in this order:

1. **Deterministic rules** — short greetings (under 20 chars: hello/hi/hey/yes/no/ok/thanks) go to the small model (`deterministic-short`); code-related requests (code/function/script, fenced blocks) go to the large model (`deterministic-code`).
2. **Classifier** — everything else is classified as simple or complex by a fast Llama-3-8B call (`classifier-simple` / `classifier-complex`).
3. **Fallback** — if the classifier errors, the query goes to the large model for safety (`classifier-error`).

Small model: `llama3-8b-8192`. Large model: `llama3-70b-8192`.

## Implementation Pointers

- Root backend entry: `src/index.ts`
- Server app bootstrap: `src/server/index.ts`
- Frontend app: `src/client/src/App.tsx`
- Product overview: `docs/overview.md`
- Status and delivery log: `docs/progress.md` (static; open work is tracked in GitHub issues)
