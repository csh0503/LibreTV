#!/bin/bash
# Ask for the DuckDNS token (hidden input) and store it as DUCKDNS_TOKEN= in /opt/libretv/.env, then test it.
set -e
f=/opt/libretv/.env
read -rsp "DuckDNS token (input hidden): " t; echo
case "$t" in ''|*[!0-9a-fA-F-]*) echo "That does not look like a DuckDNS token - nothing saved."; exit 1;; esac
umask 077
tmp=$(mktemp /opt/libretv/.env.XXXX)
grep -v '^DUCKDNS_TOKEN=' "$f" > "$tmp" || true
printf 'DUCKDNS_TOKEN=%s\n' "$t" >> "$tmp"
mv "$tmp" "$f"
echo "Saved. Testing update of qingran-libretv.duckdns.org ..."
/opt/libretv/duckdns-update.sh
