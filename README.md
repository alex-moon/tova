# HFG: Heroku for Groq

HFG is an intelligent model router and chat interface for Groq LLMs.

## Features

- **Intelligent Routing**: Automatically selects between small (Llama 3 8B) and large (Llama 3 70B) models based on query complexity.
- **Persistent Chat**: Session-based chat history stored in MongoDB.
- **Secure Auth**: JWT-based authentication with HTTP-only cookies.
- **Modern UI**: Semantic React-based chat interface.

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
    MONGODB_URI=mongodb://localhost:27017/hfg
    JWT_SECRET=your_secret_key
    GROQ_API_KEY=your_groq_api_key
    NODE_ENV=development
    ```

### Running with NPM/Makefile

- **Start Dev Environment**: `make dev` (starts both backend and frontend)
- **Start Backend Only**: `make dev-server`
- **Start Frontend Only**: `make dev-client`
- **Run Tests**: `make test`
- **Lint Code**: `make lint`

When running in development mode, you can access the application via:
- **Unified Port**: `http://localhost:5000` (Express proxying to Vite)
- **Vite Port**: `http://localhost:5173` (Vite proxying to Express)

### Running with Docker

You can run the entire stack (including MongoDB) using Docker Compose:

1.  **Build and Start**:
    ```bash
    make docker-up
    ```
2.  **Access the application**:
    - Frontend: `http://localhost:5173`
    - Backend API: `http://localhost:5000`

## Deployment

The application is configured to serve the frontend static files from the backend in production mode.

1.  **Build**:
    ```bash
    make build
    ```
2.  **Run**:
    ```bash
    NODE_ENV=production npm start
    ```

Or use the provided `Dockerfile` for a containerized production deployment.
