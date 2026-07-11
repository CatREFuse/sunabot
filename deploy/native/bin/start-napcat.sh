#!/usr/bin/env bash
set -euo pipefail

workspace="${SUNABOT_WORKSPACE:?SUNABOT_WORKSPACE is required}"
executable="${SUNABOT_NAPCAT_EXECUTABLE:-/opt/sunabot/components/napcat/opt/QQ/qq}"
account="${NAPCAT_ACCOUNT:?NAPCAT_ACCOUNT is required}"

export XDG_CONFIG_HOME="${SUNABOT_NAPCAT_CONFIG_HOME:-$workspace/runtime/napcat/config-home}"
mkdir -p "$XDG_CONFIG_HOME"
exec /usr/bin/xvfb-run -a "$executable" --no-sandbox --disable-gpu -q "$account"

