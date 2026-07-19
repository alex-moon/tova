# Tova

Tova is an intelligent model router and chat interface for Groq LLMs. Think of it as "Heroku for Groq".

## Features

- **Intelligent Routing**: Automatically selects between small (Llama 3 8B) and large (Llama 3 70B) models based on query complexity.
- **Persistent Chat**: Session-based chat history stored in MongoDB.
- **Secure Auth**: JWT-based authentication with HTTP-only cookies.
- **Modern UI**: Semantic React-based chat interface.

## Current Root Contract

The repository root now has an intentional backend contract, but the full combined local MVP workflow is still being restored packet by packet.

- Supported from the root today: backend dependency installation, backend build/test/start commands, and React client dependency install/build commands.
- Not yet supported from the root today: the unified browser-visible dev workflow or the Docker/Compose flow described in later packets.
- The existing implementation work lives under `src/server` and `src/client`, but the honest top-level workflow is being restored packet by packet.

## Local Development

### Prerequisites

- Node.js (v22+)
- MongoDB (running locally or via Docker)
- Groq API Key

### Setup

1.  **Clone the repository**
2.  **Install dependencies**
    ```bash
    make install
    ```
3.  **Configure Environment**
    Create a `.env` file in the root directory:
    ```env
    PORT=5000
    MONGODB_URI=mongodb://localhost:27017/tova
    JWT_SECRET=your_secret_key
    GROQ_API_KEY=your_groq_api_key
    NODE_ENV=development
    ```

You can also install the frontend dependencies directly without `make`:

```bash
npm install
npm run install:client
```

### Supported Root Commands

- `make install` — installs the root workspace dependencies and the frontend dependencies.
- `make build` — builds the frontend bundle from the repository root.
- `make clean` — removes installed dependencies and the frontend build output.
- `npm run build` — compiles the backend TypeScript entry to `dist/`.
- `npm test` — runs the backend Jest suite from the repository root.
- `npm start` — starts the built backend from `dist/index.js`.
- `npm run dev:server` — runs the backend entry directly in watch mode.
- `npm run install:client` — installs only the frontend dependencies.
- `npm run build:client` — builds only the frontend from the repository root.

### Deferred Root Workflows

- The unified browser-visible dev workflow is tracked by `docs/plan-003-make-the-unified-dev-workflow-runnable.md`.
- The Docker and Compose assets are not yet a supported top-level workflow and should be treated as in-progress scaffolding.

Until those packets land, contributors should treat the backend command surface as supported, but the one-command local MVP experience as not yet reconciled at the repository root.

## Implementation Pointers

- Root backend entry: `src/index.ts`
- Server app bootstrap: `src/server/index.ts`
- Frontend app: `src/client/src/App.tsx`
- Delivery plan: `docs/plan.md`
- Packet progress log: `docs/progress.md`
