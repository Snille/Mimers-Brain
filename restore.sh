#!/usr/bin/env bash
# Restores Mimers Brain from a gzipped pg_dump produced by backup.sh.
#
#   ./restore.sh ~/valv-backups/valv-20260804-1456.sql.gz
#
# The dumps are taken with --clean --if-exists, so this replaces the current
# contents of the database. It prints the row count before and after so the
# result is never in doubt.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump.sql.gz>}"
DB_CONTAINER="${DB_CONTAINER:-valv-db}"
DB_USER="${DB_USER:-mimer}"
DB_NAME="${DB_NAME:-valv}"

count() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "select count(*) from thoughts" 2>/dev/null || echo "?"; }

[ -f "$DUMP" ] || { echo "No such dump: $DUMP" >&2; exit 1; }
gzip -t "$DUMP" || { echo "Dump is not valid gzip: $DUMP" >&2; exit 1; }

echo "Rows before: $(count)"
gunzip -c "$DUMP" > /tmp/valv-restore.sql
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -q < /tmp/valv-restore.sql
rm -f /tmp/valv-restore.sql
echo "Rows after:  $(count)"
