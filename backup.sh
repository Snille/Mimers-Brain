#!/usr/bin/env bash
# Daily logical backup of Mimers Brain.
#
# Complements infrastructure-level backups. A logical dump restores selectively -
# a single thought, or the table into a fresh database - which a full container
# image cannot do.
set -euo pipefail

DIR="${BACKUP_DIR:-/home/mimer/valv-backups}"
KEEP="${BACKUP_KEEP:-10}"
DB_CONTAINER="${DB_CONTAINER:-valv-db}"
DB_USER="${DB_USER:-mimer}"
DB_NAME="${DB_NAME:-valv}"

mkdir -p "$DIR"
FILE="$DIR/valv-$(date +%Y%m%d-%H%M).sql.gz"

# --clean so the dump can be replayed into a database that already has objects.
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip -9 > "$FILE"

# A zero-length or truncated dump is worse than none: it would quietly rotate a
# good backup out. Verify the gzip stream and that the table is actually in it.
if ! gzip -t "$FILE" 2>/dev/null; then
    echo "$(date -Is) ERROR: $FILE is not valid gzip - removed" >&2
    rm -f "$FILE"
    exit 1
fi
if ! zgrep -q "COPY public.thoughts" "$FILE"; then
    echo "$(date -Is) ERROR: $FILE has no thoughts data - removed" >&2
    rm -f "$FILE"
    exit 1
fi

# Rotate only after the new dump is known good.
ls -1t "$DIR"/valv-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -Is) OK $(basename "$FILE") $(du -h "$FILE" | cut -f1), $(ls -1 "$DIR"/valv-*.sql.gz | wc -l) dumps kept"
