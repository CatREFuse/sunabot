#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
workspace="${SUNABOT_WORKSPACE:?SUNABOT_WORKSPACE is required}"
cd "$root"

if [[ -n ${SUNABOT_RELEASE_ROOT+x} || -n ${SUNABOT_NODE_EXECUTABLE+x} \
  || -n ${SUNABOT_BWRAP_EXECUTABLE+x} || -n ${SUNABOT_PACKAGED_RELEASE+x} ]]; then
  printf 'Sunabot packaged Core entry does not accept runtime executable overrides.\n' >&2
  exit 1
fi

node_bin="$root/runtime/node/bin/node"
if [[ ! -x "$node_bin" ]]; then
  printf 'Sunabot bundled Node.js runtime is unavailable.\n' >&2
  exit 1
fi
expected_node="$($node_bin -e 'const c=require(process.argv[1]); process.stdout.write(c.nodeVersion)' "$root/deploy/runtime-contract.json")"
actual_node="$($node_bin -p 'process.versions.node')"
if [[ "$actual_node" != "$expected_node" ]]; then
  printf 'Sunabot requires Node.js %s; found %s.\n' "$expected_node" "$actual_node" >&2
  exit 1
fi

bwrap_bin="$root/runtime/bubblewrap/bwrap"
if [[ "$bwrap_bin" != /* || ! -x "$bwrap_bin" ]]; then
  printf 'Sunabot workspace Bash isolation is unavailable: %s\n' "$bwrap_bin" >&2
  exit 1
fi

"$node_bin" --input-type=module -e '
  import fs from "node:fs/promises";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const root = process.argv[1];
  const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"));
  const integrity = await import(pathToFileURL(path.join(root, "tooling/runtime/release-integrity.mjs")));
  await integrity.validateReleaseManifest({ root, manifest });
' "$root"

export SUNABOT_BWRAP_EXECUTABLE="$bwrap_bin"
export SUNABOT_PACKAGED_RELEASE=1
exec "$node_bin" "$root/dist/apps/api/main.js"
