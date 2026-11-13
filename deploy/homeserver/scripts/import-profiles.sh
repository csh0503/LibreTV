#!/bin/bash
# One-time copy of LibreTV profiles from Vercel's Upstash Redis into this server's local storage.
# The URL and token are typed in hidden, kept only in this process's memory, and never written to disk.
set -euo pipefail
DATA=/opt/libretv/data/profile-sync

read -rsp "KV_REST_API_URL (input hidden): " URL; echo
read -rsp "KV_REST_API_TOKEN (input hidden): " TOKEN; echo
case "$URL" in https://*) ;; *) echo "URL must start with https:// - nothing changed."; exit 1;; esac
[ -n "$TOKEN" ] || { echo "Empty token - nothing changed."; exit 1; }

redis() { # $1 = JSON array command
  curl -sS --max-time 30 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1" "$URL"
}

# List keys with SCAN (allowed for read-only tokens, unlike KEYS).
KEYS=()
cursor=0
scan_ok=1
while :; do
  out=$(redis "$(jq -cn --arg c "$cursor" '["SCAN",$c,"MATCH","profile:*","COUNT","200"]')")
  if ! echo "$out" | jq -e '.result|type=="array"' >/dev/null 2>&1; then scan_ok=0; break; fi
  cursor=$(echo "$out" | jq -r '.result[0]')
  mapfile -t -O "${#KEYS[@]}" KEYS < <(echo "$out" | jq -r '.result[1][]')
  [ "$cursor" = "0" ] && break
done
if [ "$scan_ok" = 0 ]; then
  # Fallback: read the profile list, then each profile it names.
  echo "SCAN not allowed ($(echo "$out" | jq -r '.error? // "?"' 2>/dev/null)); reading the profile list instead."
  cat=$(redis '["GET","profile:catalog.json"]')
  if ! echo "$cat" | jq -e '.result|type=="string"' >/dev/null 2>&1; then
    echo "Could not read profile list (wrong URL/token?): $(echo "$cat" | jq -r '.error? // "not found"' 2>/dev/null)"
    exit 1
  fi
  KEYS=("profile:catalog.json")
  while read -r id; do KEYS+=("profile:profiles/$id.json"); done < <(echo "$cat" | jq -r '.result | fromjson | .profiles[]?.id // empty')
fi
echo "Found ${#KEYS[@]} items in Upstash."
[ "${#KEYS[@]}" -gt 0 ] || { echo "Nothing to import."; exit 1; }

backup="/opt/libretv/data.bak-$(date +%Y%m%d-%H%M%S)"
sudo cp -a /opt/libretv/data "$backup"
echo "Backed up current local data to $backup"

n=0
for k in "${KEYS[@]}"; do
  rel="${k#profile:}"
  case "$rel" in *..*|/*) echo "  skip unsafe key"; continue;; esac
  val=$(redis "$(jq -cn --arg k "$k" '["GET",$k]')" | jq -r '.result // empty')
  [ -n "$val" ] || { echo "  empty: $rel"; continue; }
  sudo mkdir -p "$(dirname "$DATA/$rel")"
  printf '%s' "$val" | sudo tee "$DATA/$rel" >/dev/null
  echo "  imported: $rel"
  n=$((n+1))
done
sudo chown -R 100:101 /opt/libretv/data
unset TOKEN URL
echo "DONE - imported $n items."
