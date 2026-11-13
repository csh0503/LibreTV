#!/bin/bash
# Ask for the LibreTV password (hidden input) and store it as PASSWORD= in /opt/libretv/.env.
set -e
f=/opt/libretv/.env
read -rsp "LibreTV password (input hidden): " p1; echo
read -rsp "Type it again: " p2; echo
if [ -z "$p1" ] || [ "$p1" != "$p2" ]; then echo "Empty or not matching - nothing saved."; exit 1; fi
case "$p1" in *[[:space:]]*) echo "Password must not contain spaces - nothing saved."; exit 1;; esac
umask 077
tmp=$(mktemp /opt/libretv/.env.XXXX)
grep -v '^PASSWORD=' "$f" > "$tmp" || true
printf 'PASSWORD=%s\n' "$p1" >> "$tmp"
mv "$tmp" "$f"
echo "SAVED"
