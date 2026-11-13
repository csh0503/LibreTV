# Caddy + DuckDNS DNS module (Let's Encrypt via DNS challenge; port 80 does not need to be open).
# Same recipe as the Vikunja server, without the China Go proxy.
FROM caddy:2.11.6-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2.11.6-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
