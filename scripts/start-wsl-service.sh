#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Windows proxy applications are reached through WSL's current default gateway.
# Node 24 only honors HTTP(S)_PROXY for fetch when --use-env-proxy is enabled.
if [[ -n "${WSL_INTEROP:-}" && "${SUNABOT_WINDOWS_PROXY_MODE:-auto}" != "off" && -z "${HTTPS_PROXY:-}" ]]; then
  proxy_port="${SUNABOT_WINDOWS_PROXY_PORT:-7890}"
  if [[ "$proxy_port" =~ ^[0-9]{1,5}$ ]]; then
    gateway="$(ip route show default 2>/dev/null | awk 'NR == 1 { print $3 }')"
    if [[ -n "$gateway" ]] && timeout 1 bash -c "</dev/tcp/${gateway}/${proxy_port}" 2>/dev/null; then
      export HTTP_PROXY="http://${gateway}:${proxy_port}"
      export HTTPS_PROXY="$HTTP_PROXY"
      export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost,::1}"
    fi
  fi
fi

exec /usr/bin/node --use-env-proxy "$root/dist/server.js"
