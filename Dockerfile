# Backend image (#257 workspace layout). Installs are scoped per workspace so
# the builder never pulls trees it does not build (client tooling stays out of
# server-only layers) and the prod stage carries only the server runtime tree.

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Workspace manifests first so the dependency layers cache independently of
# source changes. All four must exist: npm ci resolves the whole workspace
# graph from the root lockfile before applying the -w filter.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/
COPY apps/client/package.json apps/client/
COPY apps/migrations/package.json apps/migrations/

# --ignore-scripts: no workspace lifecycle runs before its sources are copied.
RUN npm ci -w apps/shared -w apps/server -w apps/client --ignore-scripts

# Sources: shared (types boundary), server, and the client build that the
# server embeds as the production static fallback (nginx is the primary
# frontend path; the embedded copy serves direct backend-port access).
COPY apps/shared apps/shared
COPY apps/server apps/server
COPY apps/client apps/client

# Build order matters: shared emits the contracts d.ts that server tsc
# consumes; the client build is independent.
RUN npm run build -w apps/shared && npm run build -w apps/server && npm run build -w apps/client

# Production stage
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/

# Server runtime tree only. @tova/shared is types-only by contract — every
# server import of it is elided at emit — so its dist is intentionally absent.
RUN npm ci -w apps/server --omit=dev --ignore-scripts

# Built assets: server dist, the embedded client dist, and the vendored
# tessdata (#209: OCR must not egress to a CDN at recognition time).
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/client/dist ./apps/client/dist
COPY assets ./assets

# Expose port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production

# Start the server
CMD ["node", "apps/server/dist/main.js"]
