#!/usr/bin/env bash
# Daily logical backup of Mimers Brain.
#
# Complements infrastructure-level backups kept outside this repository. A
# logical dump
# restores selectively - a single thought, or the table into a fresh database -
# which a full container image cannot do.
set -euo pipefail

DIR=/home/mimer/valv-backups
KEEP=10

mkdir -p "$DIR"
FILE="$DIR/valv-$(date +%Y%m%d-%H%M).sql.gz"

# --clean so the dump can be replayed into a database that already has objects.
docker exec valv-db pg_dump -U mimer -d valv --clean --if-exists | gzip -9 > "$FILE"

# A zero-length or truncated dump is worse than none: it would quietly rotate a
# good backup out. Verify the gzip stream and that the table is actually in it.
if ! gzip -t "$FILE" 2>/dev/null; then
    echo "$(date -Is) FEL: $FILE ar ingen giltig gzip - tar bort" >&2
    rm -f "$FILE"
    exit 1
fi
if ! zgrep -q "COPY public.thoughts" "$FILE"; then
    echo "$(date -Is) FEL: $FILE saknar thoughts-data - tar bort" >&2
    rm -f "$FILE"
    exit 1
fi

# Rotate only after the new dump is known good.
ls -1t "$DIR"/valv-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -Is) OK $(basename "$FILE") $(du -h "$FILE" | cut -f1), $(ls -1 "$DIR"/valv-*.sql.gz | wc -l) dumpar sparade"
