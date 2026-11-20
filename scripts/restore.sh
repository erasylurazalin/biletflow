#!/usr/bin/env bash
# Loads a dump from scripts/backup.sh into the compose database (the db service),
# replacing what is there. Runs in one transaction: on any error nothing changes.
#
#   scripts/restore.sh backups/biletflow-20261027-120000.sql
#
# The db service must be running (`docker compose up -d db`). Restarting the api
# service afterwards re-runs the seed, which resets the demo rows to their defaults.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup.sql>" >&2
  exit 1
fi
if [ ! -f "$1" ]; then
  echo "No such file: $1" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"

docker compose -f "$root/docker-compose.yml" exec -T db \
  psql -U biletflow -d biletflow -q -v ON_ERROR_STOP=1 --single-transaction <"$1"

echo "Restored $1"
