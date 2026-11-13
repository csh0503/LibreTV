#!/bin/bash
# Set the password for the VPN page (https://qingran-cuhkvpn.duckdns.org). Login name is "qingran".
set -e
read -rsp "VPN page password (input hidden): " p1; echo
read -rsp "Type it again: " p2; echo
[ -n "$p1" ] && [ "$p1" = "$p2" ] || { echo "Empty or not matching - nothing saved."; exit 1; }
hash=$(printf '%s\n%s\n' "$p1" "$p1" | docker exec -i libretv-caddy caddy hash-password 2>/dev/null | tail -1)
case "$hash" in '$2'*) ;; *) echo "Could not create the password hash - nothing saved."; exit 1;; esac
cd /opt/libretv
umask 077
tmp=$(mktemp /opt/libretv/.env.XXXX)
grep -v '^VPN_PANEL_HASH=' .env > "$tmp" || true
printf "VPN_PANEL_HASH='%s'\n" "$hash" >> "$tmp"   # single quotes: stop Compose expanding the \$ in the hash
mv "$tmp" .env
docker compose up -d caddy >/dev/null 2>&1
echo "SAVED - open https://qingran-cuhkvpn.duckdns.org (user: qingran)"
