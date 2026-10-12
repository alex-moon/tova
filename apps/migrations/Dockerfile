# One-shot migration runner (#257). Compose starts this service before the
# backend (backend gates on service_completed_successfully): it connects to
# exactly the DB the backend sees (same .env / MONGODB_URL, from inside the
# compose network), runs `up`, and exits.
#
# Only the migrations + shared workspace trees are installed (#257 follow-up):
# the runner no longer depends on @tova/server, so the server runtime
# (mongoose, express, ...) stays out of this image. buildMongoUri lives in
# @tova/shared and is imported from source, so no shared build step is needed.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/migrations/package.json apps/migrations/
COPY apps/shared/package.json apps/shared/

# --ignore-scripts keeps workspace lifecycles from running before sources are
# copied.
RUN npm ci -w apps/migrations --ignore-scripts

COPY apps/migrations/src apps/migrations/src
COPY apps/shared/src apps/shared/src

WORKDIR /app/apps/migrations

# `npm run migrate` = tsx src/index.ts up (exits 0 when all migrations apply)
CMD ["npm", "run", "migrate"]
