#!/usr/bin/env bash
set -euo pipefail

APP_NAME=tova
SSH_HOST=${SSH_HOST:-root@142.93.42.191}

# Authenticate Docker Hub on the deploy host (its `docker compose build`
# pulls the base images): the token travels via stdin, never argv. When the
# credentials are absent, pulls stay anonymous — deploy still works, just
# rate-limited.
if [[ -n ${DOCKERHUB_USERNAME:-} && -n ${DOCKERHUB_TOKEN:-} ]]; then
  printf '%s' "$DOCKERHUB_TOKEN" |
    ssh -o BatchMode=yes "$SSH_HOST" "docker login -u '$DOCKERHUB_USERNAME' --password-stdin"
fi

# #257: no host node_modules, no host builds, no host migrations. Everything
# builds inside images; the one-shot `migrations` compose service runs `up`
# on the compose network and gates the backend via
# service_completed_successfully. Compose interpolates ${MONGODB_URL} from
# the project .env itself, so the script no longer sources it.
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

docker compose -f docker-compose.live.yml build
docker compose -f docker-compose.live.yml up -d --remove-orphans
docker system prune -f
SCRIPT_EOF
