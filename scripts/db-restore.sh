#!/usr/bin/env bash
# db-restore.sh — restore a dump tarball from db-dump.sh into a target Mongo db.
#
# Cutover sequence and notes are in db-dump.sh. This script always runs
# `mongorestore --drop`: it REPLACES the target database's contents. It
# therefore prompts for explicit confirmation before touching anything, and
# the target db name is a required argument here (no silent default, so a
# mistyped/absent arg cannot point at live data by accident).
#
# Credentials are never committed or echoed: the target URI comes from
# MONGODB_RESTORE_URI (export it or pass inline). Atlas URIs use the
# mongodb+srv:// scheme; local URIs are plain mongodb://.
#
# Example — restore the latest local dump into Atlas (run LAST, after the
# Atlas cluster and database user exist):
#   MONGODB_RESTORE_URI='mongodb+srv://<user>:<password>@<cluster-host>/?appName=<app>' \
#     scripts/db-restore.sh --tarball tmp/db-dumps/tova-tova-20260921-120000.tar.gz \
#       --target-db tova
set -euo pipefail

if ! command -v mongorestore >/dev/null 2>&1; then
  echo "mongorestore not found on PATH. Install MongoDB Database Tools: https://www.mongodb.com/docs/database-tools/installation/" >&2
  exit 1
fi

if [[ -z ${MONGODB_RESTORE_URI:-} ]]; then
  echo "Set MONGODB_RESTORE_URI to the target connection URI (e.g. mongodb+srv://... for Atlas)." >&2
  exit 1
fi

TARBALL=
TARGET_DB=
while [[ $# -gt 0 ]]; do
  case $1 in
    --tarball) TARBALL=$2; shift 2 ;;
    --target-db) TARGET_DB=$2; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z ${TARBALL} || ! -f ${TARBALL} ]]; then
  echo "Usage: MONGODB_RESTORE_URI=<uri> $0 --tarball <tarball> --target-db <tova|other>" >&2
  exit 1
fi
if [[ -z ${TARGET_DB} ]]; then
  echo "A --target-db is required (restore always drops the target db)." >&2
  exit 1
fi

echo "This runs 'mongorestore --drop' against the target db '${TARGET_DB}'."
echo "Its existing contents will be DELETED and replaced by the dump."
read -r -p "Continue? [yes/no] " reply
if [[ ${reply} != yes ]]; then
  echo "Aborted — target untouched."
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d "${REPO_ROOT}/tmp/db-dumps/restore-XXXXXX")
trap 'rm -rf "${WORK_DIR}"' EXIT
tar -xzf "${TARBALL}" -C "${WORK_DIR}"
# mongodump --out lays out <out>/<dbname>/...; the tarball is built one level
# above that, so the restore path is whatever named directory it contains.
entries=("${WORK_DIR}"/*)
if [[ ${#entries[@]} -ne 1 ]]; then
  echo "Tarball does not contain exactly one dumped db directory — refusing." >&2
  exit 1
fi
restore_uri=
base=${MONGODB_RESTORE_URI%%\?*}
query=${MONGODB_RESTORE_URI:${#base}}
base=${base%/[^/]*}
base=${base%/}/
restore_uri="${base}${TARGET_DB}${query}"
mongorestore --uri "${restore_uri}" --db "${TARGET_DB}" --drop "${entries[0]}"
