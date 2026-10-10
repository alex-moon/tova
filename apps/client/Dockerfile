# Client image (#257 workspace layout): build the React app from the client
# workspace tree only, then serve the static build with nginx.

# Stage 1: build the compiled React app
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/shared/package.json apps/shared/
COPY apps/server/package.json apps/server/
COPY apps/migrations/package.json apps/migrations/

# Scoped install (#257): client tree only; server tooling stays out.
# --ignore-scripts: no workspace lifecycle runs before its sources are copied.
RUN npm ci -w apps/client --ignore-scripts

# The client type-imports shared through the @shared alias into
# ../shared/src — the types sources must be present for tsc and vite.
COPY apps/shared/src apps/shared/src
COPY apps/client apps/client

RUN npm run build -w apps/client

# Stage 2: serve the static build with nginx
FROM nginx:alpine

COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=0 /app/apps/client/dist /usr/share/nginx/html

EXPOSE 4173
