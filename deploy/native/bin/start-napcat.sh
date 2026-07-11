#!/usr/bin/env bash
set -euo pipefail

workspace="${SUNABOT_WORKSPACE:?SUNABOT_WORKSPACE is required}"
release_root="${SUNABOT_RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
contract_path="$release_root/deploy/runtime-contract.json"
component_root="${SUNABOT_NAPCAT_COMPONENT_ROOT:-/opt/sunabot/components/napcat/current}"
executable="${SUNABOT_NAPCAT_EXECUTABLE:-$component_root/opt/QQ/qq}"
shell_root="${SUNABOT_NAPCAT_SHELL_ROOT:-$component_root/app/napcat}"
defaults_root="$component_root/app/napcat-default-config"
runtime_paths="$(/usr/bin/env node -e '
const fs = require("node:fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const readRelativePath = (name) => {
  const value = contract.paths?.[name];
  if (typeof value !== "string" || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid runtime path: ${name}`);
  }
  return value;
};
process.stdout.write(`${readRelativePath("napcatConfig")}\t${readRelativePath("napcatState")}\t${readRelativePath("napcatQrCode")}`);
' "$contract_path")"
IFS=$'\t' read -r napcat_config_relative napcat_state_relative napcat_qr_relative <<< "$runtime_paths"
config_root="$workspace/$napcat_config_relative"
home_root="$workspace/$napcat_state_relative/qq"
cache_root="$shell_root/cache"
expected_cache_root="$workspace/$napcat_state_relative"

if [[ "$(dirname "$napcat_qr_relative")" != "$napcat_state_relative" ]]; then
  printf 'NapCat QR path must be contained by the runtime state.\n' >&2
  exit 1
fi
if [[ ! -L "$cache_root" || "$(readlink -f "$cache_root")" != "$(readlink -f "$expected_cache_root")" ]]; then
  printf 'NapCat cache must link to %s. Run the Native install/upgrade command first.\n' "$expected_cache_root" >&2
  exit 1
fi

mkdir -p "$config_root" "$home_root/.config"
if [[ ! -f "$config_root/napcat.json" ]]; then
  cp -a "$defaults_root/." "$config_root/"
fi

export HOME="$home_root"
export XDG_CONFIG_HOME="$home_root/.config"
export FFMPEG_PATH=/usr/bin/ffmpeg
args=(
  -a
  -s "-screen 0 1080x760x16 +extension GLX +render"
  "$executable"
  --no-sandbox
)
if [[ -n "${NAPCAT_ACCOUNT:-}" ]]; then
  args+=(-q "$NAPCAT_ACCOUNT")
fi

cd "$shell_root"
exec /usr/bin/xvfb-run "${args[@]}"
