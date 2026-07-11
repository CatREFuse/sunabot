#!/usr/bin/env bash
set -euo pipefail

workspace="${SUNABOT_WORKSPACE:?SUNABOT_WORKSPACE is required}"
component_root="${SUNABOT_NAPCAT_COMPONENT_ROOT:-/opt/sunabot/components/napcat/current}"
executable="${SUNABOT_NAPCAT_EXECUTABLE:-$component_root/opt/QQ/qq}"
shell_root="${SUNABOT_NAPCAT_SHELL_ROOT:-$component_root/app/napcat}"
defaults_root="$component_root/app/napcat-default-config"
config_root="$workspace/runtime/napcat/config"
home_root="$workspace/runtime/napcat/qq"

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
