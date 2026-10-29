#!/bin/bash
# Ежедневная копия базы finnik в российское хранилище (Timeweb S3)
set -euo pipefail
source /root/finnik.env
TS=$(date -u +%Y-%m-%d_%H%M)
DIR=/root/backups
F="$DIR/finnik_$TS.dump"
mkdir -p "$DIR" && chmod 700 "$DIR"

# При любой ошибке: удалить неполный файл и записать FAILED в лог
trap 'CODE=$?; [ -f "$F" ] && rm -f "$F"; echo "$(date -u +%FT%TZ) backup FAILED: finnik_$TS.dump (exit $CODE)"; exit $CODE' ERR

pg_dump "$DATABASE_URL" -Fc -f "$F" \
  --exclude-table='tmp_*'
pg_restore -l "$F" > /dev/null          # файл читается
rclone copyto "$F" "tw:finnik-backups/daily/finnik_$TS.dump"
find "$DIR" -name 'finnik_*.dump' -mtime +3 -delete
rclone delete tw:finnik-backups/daily --min-age 30d
echo "$(date -u +%FT%TZ) backup OK: finnik_$TS.dump $(stat -c %s "$F") bytes"
