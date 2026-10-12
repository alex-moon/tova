# Backend image (#257 workspace layout). Installs are scoped per workspace so
# the builder never pulls trees it does not build (client tooling stays out of
# server-only layers) and the prod stage carries only the server runtime tree.
#
# The client and server builds run as separate stages (#257 follow-up) so
# BuildKit builds them in parallel and neither install drags in the other's
# toolchain.

# Client build stage: the server embeds the client bundle as the production
# static fallback (nginx is the primary frontend path; the embedded copy serves
# direct backend-port access).
FROM node:22-alpine AS client-builder

WORKDIR /app

# Workspace manifests first so the dependency layer caches independently of
# source changes. The client type-imports shared through the @shared alias into
# ../shared/src, so only shared's manifest is needed here (no shared build).
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/shared/package.json apps/shared/

RUN npm ci -w apps/client --ignore-scripts

COPY apps/shared/src apps/shared/src
COPY apps/client apps/client

RUN npm run build -w apps/client

# Server build stage: shared (types boundary + mongoUri runtime helper) then
# server. Shared must build first: server tsc consumes its emitted d.ts.
FROM node:22-alpine AS server-builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/

RUN npm ci -w apps/server --ignore-scripts

COPY apps/shared apps/shared
COPY apps/server apps/server

RUN npm run build -w apps/shared && npm run build -w apps/server

# Production stage
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/

# Server runtime tree only. @tova/shared is now a runtime dependency (server
# imports buildMongoUri), so its emitted dist ships below; its own deps are nil.
RUN npm ci -w apps/server --omit=dev --ignore-scripts

# Built assets: server dist, shared runtime dist, the embedded client dist, and
# the vendored tessdata (#209: OCR must not egress to a CDN at recognition time).
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=server-builder /app/apps/shared/dist ./apps/shared/dist
COPY --from=client-builder /app/apps/client/dist ./apps/client/dist
COPY assets ./assets

# Expose port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production

# Start the server
CMD ["node", "apps/server/dist/main.js"]
