#!/bin/sh
# Daily backup of /opt/libretv/data (profiles & watch history), keeping the last 14 backups.
set -eu
BACKUP_DIR=/opt/libretv/backups
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F)
TMP="$BACKUP_DIR/libretv-data-$STAMP.tar.gz.tmp"
OUT="$BACKUP_DIR/libretv-data-$STAMP.tar.gz"
# catalog/ = the local film library (SQLite, rebuilt from the internet by the app itself) - not worth backing up
tar czf "$TMP" --exclude=data/catalog -C /opt/libretv data
mv "$TMP" "$OUT"
ls -1t "$BACKUP_DIR"/libretv-data-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
