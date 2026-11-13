#!/bin/sh
# Point home's .duckdns.org domains at this home's current public IP (run every 5 minutes by cron).
# qingran-todo (Tencent Cloud) and qingran-hk (another host) are NOT touched here.
TOKEN=$(grep '^DUCKDNS_TOKEN=' /opt/libretv/.env | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "$(date '+%F %T') no DUCKDNS_TOKEN in .env"; exit 1; }
r=$(curl -s --max-time 20 "https://www.duckdns.org/update?domains=qingran-libretv,qingran-cuhkvpn,qingran-mausbot&token=$TOKEN&ip=")
echo "$(date '+%F %T') $r"
