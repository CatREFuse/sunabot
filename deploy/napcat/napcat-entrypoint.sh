#!/usr/bin/env bash
set -euo pipefail

config_root=/app/napcat/config
manual_login_marker=/app/napcat/cache/manual-login-required
account_env=/app/napcat/cache/account.env
mkdir -p "$config_root"

if [[ ! -f "$config_root/napcat.json" ]]; then
  temporary_root=$(mktemp -d)
  trap 'rm -rf "$temporary_root"' EXIT
  unzip -q /app/NapCat.Shell.zip -d "$temporary_root"
  cp -an "$temporary_root/config/." "$config_root/"
fi

[[ -f "$config_root/napcat.json" ]] || { echo "NapCat 配置初始化失败" >&2; exit 1; }
[[ -f "$config_root/webui.json" ]] || { echo "NapCat WebUI 配置初始化失败" >&2; exit 1; }

requested_account=${ACCOUNT:-}
if [[ -f "$account_env" ]]; then
  requested_account=$(sed -n 's/^NAPCAT_ACCOUNT=//p' "$account_env")
fi
[[ ! -f "$manual_login_marker" ]] || requested_account=
temporary_webui="$config_root/webui.json.$$.tmp"
jq --arg account "$requested_account" '.autoLoginAccount = $account' \
  "$config_root/webui.json" > "$temporary_webui"
chmod 0600 "$temporary_webui"
mv "$temporary_webui" "$config_root/webui.json"
export ACCOUNT=

exec bash /app/entrypoint.sh
