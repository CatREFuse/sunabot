#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(tr -d '[:space:]' < "$ROOT/.node-version")
LOCK="$ROOT/package-lock.json"
INSTALL_MARKER="$ROOT/node_modules/.package-lock.json"

needs_install() {
  [ ! -f "$INSTALL_MARKER" ] || [ "$LOCK" -nt "$INSTALL_MARKER" ]
}

if command -v fnm >/dev/null 2>&1 && fnm exec --using="$VERSION" node -e "" >/dev/null 2>&1; then
  if needs_install; then
    echo "正在安装运行依赖..."
    (cd "$ROOT" && fnm exec --using="$VERSION" npm ci)
  fi
  exec fnm exec --using="$VERSION" node "$ROOT/tooling/runtime/launcher.mjs" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node $VERSION。请安装该版本后重试。" >&2
  exit 1
fi

CURRENT=$(node -p 'process.versions.node')
if [ "$CURRENT" != "$VERSION" ]; then
  echo "需要 Node $VERSION，当前为 $CURRENT。可执行：fnm install $VERSION" >&2
  exit 1
fi

if needs_install; then
  echo "正在安装运行依赖..."
  (cd "$ROOT" && npm ci)
fi

exec node "$ROOT/tooling/runtime/launcher.mjs" "$@"
