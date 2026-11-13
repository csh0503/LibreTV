#!/bin/bash
# Ask for the TMDB API key (hidden input), store it as TMDB_API_KEY= in /opt/libretv/.env, restart LibreTV.
set -e
cd /opt/libretv
read -rsp "TMDB API key (input hidden): " k; echo
case "$k" in ''|*[[:space:]]*) echo "Empty or contains spaces - nothing saved."; exit 1;; esac
umask 077
tmp=$(mktemp /opt/libretv/.env.XXXX)
grep -v '^TMDB_API_KEY=' .env > "$tmp" || true
printf 'TMDB_API_KEY=%s\n' "$k" >> "$tmp"
mv "$tmp" .env
docker compose up -d libretv >/dev/null 2>&1
echo "SAVED - LibreTV restarted."
