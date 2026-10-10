# One-shot migration runner (#257). Compose starts this service before the
# backend (backend gates on service_completed_successfully): it connects to
# exactly the DB the backend sees (same .env / MONGODB_URL, from inside the
# compose network), runs `up`, and exits.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/migrations/package.json apps/migrations/
COPY apps/server/package.json apps/server/
COPY apps/shared/package.json apps/shared/
COPY apps/client/package.json apps/client/

# @tova/server is a declared workspace dependency, so this pulls the server
# runtime tree (mongoose etc.). --ignore-scripts keeps workspace lifecycles
# from running before sources are copied.
RUN npm ci -w apps/migrations --ignore-scripts

# The migration CLI imports server source (mongoUri) via relative paths, so
# the server sources ride along. The types-only @tova/shared imports are
# elided by tsx at runtime; the shared workspace link satisfies resolution.
COPY apps/migrations/src apps/migrations/src
COPY apps/server/src apps/server/src

WORKDIR /app/apps/migrations

# `npm run migrate` = tsx src/index.ts up (exits 0 when all migrations apply)
CMD ["npm", "run", "migrate"]
