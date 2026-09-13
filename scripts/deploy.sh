#!/usr/bin/env bash
set -euo pipefail

APP_NAME=tova
SSH_HOST=${SSH_HOST:-root@142.93.42.191}
APP_DIR=/opt/${APP_NAME}

ssh -o BatchMode=yes ${SSH_HOST} bash -s <<'SCRIPT_EOF'
set -euo pipefail

if [[ ! -d /opt/tova ]]; then
  mkdir -p /opt/tova
  cd /opt/tova
  git clone https://github.com/alex-moon/tova .
else
  cd /opt/tova
  # A pre-existing clone may have a stale origin/main ref; fetch first.
  git fetch origin
fi

git reset --hard origin/main

npm install
npm run build
npm run build:client

docker compose -f docker-compose.live.yml build
docker compose -f docker-compose.live.yml up -d --remove-orphans

# Wait until the published mongo port answers before migrating.
ready=0
for i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ $ready -ne 1 ]]; then
  echo "MongoDB did not become ready on 127.0.0.1:27017" >&2
  exit 1
fi

# The backend reads the DB state on boot; run migrations after the stack is up,
# then restart the backend so it serves the migrated DB.
# MONGODB_HOST is pinned to 127.0.0.1: .env carries MONGODB_HOST=mongodb (the
# compose service name the backend container needs), which is unresolvable
# from the host shell where migrations run.
MONGODB_HOST=127.0.0.1 npm run db:migrate
docker compose -f docker-compose.live.yml restart backend

docker system prune -f
SCRIPT_EOF
