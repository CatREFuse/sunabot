#!/usr/bin/env bash
set -euo pipefail

root="${SUNABOT_RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
workspace="${SUNABOT_WORKSPACE:?SUNABOT_WORKSPACE is required}"
cd "$root"

node_bin="${SUNABOT_NODE_EXECUTABLE:-$(command -v node)}"
expected_node="$($node_bin -e 'const c=require(process.argv[1]); process.stdout.write(c.nodeVersion)' "$root/deploy/runtime-contract.json")"
actual_node="$($node_bin -p 'process.versions.node')"
if [[ "$actual_node" != "$expected_node" ]]; then
  printf 'Sunabot requires Node.js %s; found %s.\n' "$expected_node" "$actual_node" >&2
  exit 1
fi

bwrap_bin="$($node_bin -e 'const c=require(process.argv[1]); process.stdout.write(c.capabilities.workspaceBash.executable)' "$root/deploy/runtime-contract.json")"
if [[ "$bwrap_bin" != /* || ! -x "$bwrap_bin" ]]; then
  printf 'Sunabot workspace Bash isolation is unavailable: %s\n' "$bwrap_bin" >&2
  exit 1
fi

exec "$node_bin" "$root/dist/apps/api/main.js"
