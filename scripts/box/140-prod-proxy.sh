#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
install -d -m 700 /data/coolify/proxy/dynamic
put /data/coolify/proxy/docker-compose.yml 644 < "$BOX_DIR/proxy.compose.yml"
compose_up coolify-proxy /data/coolify/proxy/docker-compose.yml /dev/null
curl -fsS http://127.0.0.1/ping
