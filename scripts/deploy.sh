#!/usr/bin/env bash
set -euo pipefail

APP_NAME=tova

ssh -t root@142.93.42.191 "
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
  npm run db:migrate;
  # The backend reads the DB state on boot; give it the migrated DB.
  docker compose -f docker-compose.live.yml restart backend;
  docker system prune -f
"
