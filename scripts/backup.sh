#!/usr/bin/env bash
# Dumps the compose database (the db service) to a plain SQL file.
#
#   scripts/backup.sh                    # backups/biletflow-<date>-<time>.sql
#   scripts/backup.sh path/to/file.sql
#
# The dump drops each object before recreating it, so scripts/restore.sh can load it
# into an empty database or over an existing one.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/backups/biletflow-$(date +%Y%m%d-%H%M%S).sql}"
mkdir -p "$(dirname "$out")"

# Written to a temporary name first, so a failed dump never looks like a good backup.
docker compose -f "$root/docker-compose.yml" exec -T db \
  pg_dump -U biletflow -d biletflow --clean --if-exists --no-owner >"$out.partial"
mv "$out.partial" "$out"

echo "Backup written to $out"
