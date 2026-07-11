#!/usr/bin/env bash
set -euo pipefail

bark_url="${BARK_URL:-}"
bark_icon="${BARK_ICON:-https://static.kivo.wiki/images/students/%E6%99%AE%E6%8B%89%E5%A8%9C/avatar.png}"
message="${*:-未知通知}"

if [[ -z "$bark_url" ]]; then
  printf 'BARK_URL is not configured; set it in workspace/.env or WebUI.\n' >&2
  exit 2
fi

encoded="$(
  node -e 'process.stdout.write(encodeURIComponent(process.argv.slice(1).join(" ")))' "$message"
)"
icon_encoded="$(
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$bark_icon"
)"

curl -fsS "${bark_url%/}/$encoded?icon=$icon_encoded" >/dev/null
