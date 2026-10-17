# Backend image; installs are scoped per workspace and the client/server build stages run in parallel.
# @see #257 #288

# Client build stage: the server embeds this bundle as the static fallback behind nginx.
FROM node:22-alpine AS client-builder

WORKDIR /app

# Manifests first so the dependency layer caches independently of source; only shared's manifest is needed (no shared build).
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/shared/package.json apps/shared/

RUN npm ci -w apps/client --ignore-scripts

COPY apps/shared/src apps/shared/src
COPY apps/client apps/client

RUN npm run build -w apps/client

# Server build stage: `tsc -b` follows the project reference to build shared first.
# @see #288
FROM node:22-alpine AS server-builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/

RUN npm ci -w apps/server --ignore-scripts

COPY apps/shared apps/shared
COPY apps/server apps/server

RUN npm run build -w apps/server

# Production stage
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/

# Server runtime tree only; shared's emitted dist ships as a runtime dependency.
RUN npm ci -w apps/server --omit=dev --ignore-scripts

# Built assets: server dist, shared dist, embedded client dist, vendored tessdata.
# @see #209
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=server-builder /app/apps/shared/dist ./apps/shared/dist
COPY --from=client-builder /app/apps/client/dist ./apps/client/dist
COPY assets ./assets

EXPOSE 5000

ENV NODE_ENV=production

CMD ["node", "apps/server/dist/main.js"]
