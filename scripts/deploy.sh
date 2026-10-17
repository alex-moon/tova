#!/usr/bin/env bash
set -euo pipefail

APP_NAME=tova
SSH_HOST=${SSH_HOST:-root@142.93.42.191}

# Authenticate Docker Hub on the deploy host via stdin; anonymous pulls still work, just rate-limited.
if [[ -n ${DOCKERHUB_USERNAME:-} && -n ${DOCKERHUB_TOKEN:-} ]]; then
  printf '%s' "$DOCKERHUB_TOKEN" |
    ssh -o BatchMode=yes "$SSH_HOST" "docker login -u '$DOCKERHUB_USERNAME' --password-stdin"
fi

# Everything builds inside images; the one-shot migrations service gates the backend on the compose network.
# @see #257
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
