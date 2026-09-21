#!/usr/bin/env bash
# db-dump.sh — dump the Tova Mongo database to a dated tarball.
#
# Migration to Atlas sequence (see db-restore.sh for the second half):
#   1. Stop the app (docker compose down or equivalent) so no writes land
#      between dump and restore — a brief maintenance window is assumed.
#   2. Run this script against the CURRENT (source) deployment.
#   3. Run db-restore.sh with the Atlas target URI and a db name (default
#      `tova`). Restore always drops the target db, so run it where you
#      accept that — the confirm prompt defends against wrong-target runs.
#   4. Point MONGODB_URL at Atlas, deploy, run db:migrate, restart.
#   (Users/JWTs carry no Mongo dependency change; no data needs reshaping.)
#
# Credentials are never committed or echoed here: the connection URI comes
# from the MONGODB_DUMP_URI env var (supply it on the command line or export
# it in .env, which is git-ignored). A db name defaults to `tova`.
#
# Example — dump the live compose-local Mongo through its published port:
#   MONGODB_DUMP_URI='mongodb://tova:<password>@127.0.0.1:27017/tova?authSource=admin' \
#     scripts/db-dump.sh
set -euo pipefail

if ! command -v mongodump >/dev/null 2>&1; then
  echo "mongodump not found on PATH. Install MongoDB Database Tools: https://www.mongodb.com/docs/database-tools/installation/" >&2
  exit 1
fi

if [[ -z ${MONGODB_DUMP_URI:-} ]]; then
  echo "Set MONGODB_DUMP_URI to the source connection URI (e.g. mongodb://... with credentials)." >&2
  echo "It is never read from or written to any committed file." >&2
  exit 1
fi

SOURCE_DB=tova
while [[ $# -gt 0 ]]; do
  case $1 in
    --source-db) SOURCE_DB=$2; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DUMP_DIR=${REPO_ROOT}/tmp/db-dumps
mkdir -p "${DUMP_DIR}"
STAMP=$(date +%Y%m%d-%H%M%S)
WORK_DIR=$(mktemp -d "${REPO_ROOT}/tmp/db-dumps/dump-${STAMP}.XXXXXX")
trap 'rm -rf "${WORK_DIR}"' EXIT

# Resume the compose-local stack if it is not up (non-fatal: Atlas sources
# will always be reachable already).
mongodump --uri "${MONGODB_DUMP_URI}" --db "${SOURCE_DB}" --out "${WORK_DIR}" || {
  echo "mongodump failed — no dump file was produced." >&2
  exit 1
}

TARBALL=${DUMP_DIR}/tova-${SOURCE_DB}-${STAMP}.tar.gz
tar -czf "${TARBALL}" -C "${WORK_DIR}" .
echo "wrote ${TARBALL}"
