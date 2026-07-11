#!/usr/bin/env bash
set -euo pipefail

root="${SUNABOT_RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
cd "$root"

# Windows proxy applications are reached through WSL's current default gateway.
# Node 24 only honors HTTP(S)_PROXY for fetch when --use-env-proxy is enabled.
is_wsl=false
if [[ -n "${WSL_INTEROP:-}" || -e /proc/sys/fs/binfmt_misc/WSLInterop ]] \
  || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  is_wsl=true
fi

if [[ "$is_wsl" == "true" && "${SUNABOT_WINDOWS_PROXY_MODE:-auto}" != "off" && -z "${HTTPS_PROXY:-}" ]]; then
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

node_bin="${SUNABOT_NODE_EXECUTABLE:-$(command -v node)}"
node_major="$($node_bin -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 24 )); then
  printf 'Sunabot requires Node.js 24 or newer; found %s.\n' "$($node_bin -v)" >&2
  exit 1
fi

exec "$node_bin" --use-env-proxy "$root/dist/server.js"
