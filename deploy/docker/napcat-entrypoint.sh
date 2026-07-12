#!/usr/bin/env bash
set -euo pipefail

config_root=/app/napcat/config
manual_login_marker=/app/napcat/cache/manual-login-required
mkdir -p "$config_root"

# A launcher may write onebot11.json before the first container start. Seed only
# missing NapCat defaults so that the upstream entrypoint does not replace it.
if [[ ! -f "$config_root/napcat.json" ]]; then
  temporary_root="$(mktemp -d)"
  trap 'rm -rf "$temporary_root"' EXIT
  unzip -q /app/NapCat.Shell.zip -d "$temporary_root"
  cp -an "$temporary_root/config/." "$config_root/"
fi

if [[ ! -f "$config_root/napcat.json" ]]; then
  echo "NapCat default configuration initialization failed" >&2
  exit 1
fi
if [[ ! -f "$config_root/webui.json" ]]; then
  echo "NapCat WebUI configuration initialization failed" >&2
  exit 1
fi

requested_account="${ACCOUNT:-}"
if [[ -f "$manual_login_marker" ]]; then
  requested_account=
fi
temporary_webui="$config_root/webui.json.$$.tmp"
jq --arg account "$requested_account" '.autoLoginAccount = $account' \
  "$config_root/webui.json" > "$temporary_webui"
chmod 0600 "$temporary_webui"
mv "$temporary_webui" "$config_root/webui.json"
export ACCOUNT=

exec bash /app/entrypoint.sh
