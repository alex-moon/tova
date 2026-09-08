#!/usr/bin/env bash
# Deploy tova to ajmoon.com (see issue #8).
# Pattern from the ported Makefile.bak: keeps the app under /opt/tova on the
# server, resets it to origin/main, installs, builds, and redeploys the
# docker stack from docker-compose.live.yml.
set -euo pipefail

APP_NAME=tova

ssh -t ajmoon "
  if [[ ! -d '/opt/${APP_NAME}' ]]; then
    mkdir -p /opt/${APP_NAME};
    cd /opt/${APP_NAME};
    git clone https://github.com/alex-moon/${APP_NAME} .;
  fi;
  cd /opt/${APP_NAME};
  git reset --hard origin/main;
  npm install;
  npm run build;
  npm run build:client;
  docker compose -f docker-compose.live.yml build;
  docker compose -f docker-compose.live.yml up -d --remove-orphans;
  docker system prune -f
"
