#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(tr -d '[:space:]' < "$ROOT/.node-version")
LOCK="$ROOT/package-lock.json"
INSTALL_MARKER="$ROOT/node_modules/.package-lock.json"
RELEASE_MANIFEST="$ROOT/release-manifest.json"
BUNDLED_NODE="$ROOT/runtime/node/bin/node"

usage() {
  cat <<'EOF'
用法：./sunabot.sh <命令> [选项]

命令：
  up          启动 Sunabot Core 与全部已启用 QQ
  start       与 up 相同：清理当前 workspace 后完整启动
  down        停止当前 workspace 的运行组件
  restart     重启当前 workspace
  status      读取运行状态
  doctor      读取环境与运行诊断
  logs        跟随当前运行日志
  bootstrap   校验发行包运行依赖；源码目录中安装开发依赖
  rollback-first-run  回滚未完成的首次运行
  soul        导出、检查或导入 Agent 灵魂文件
  upgrade-0.3.0  合并 0.2.0 的旧 Workbench 资源
  help        显示帮助

选项：
  --dev
EOF
}

COMMAND=${1:-up}
case "$COMMAND" in
  -h|--help|help)
    usage
    exit 0
    ;;
  --dev)
    COMMAND=up
    ;;
esac

ensure_macos_homebrew_path() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  for directory in /opt/homebrew/bin /usr/local/bin; do
    [ -d "$directory" ] || continue
    case ":$PATH:" in
      *":$directory:"*) ;;
      *) PATH="${PATH:+$PATH:}$directory" ;;
    esac
  done
  export PATH
}

allows_install() {
  [ "$COMMAND" = "up" ] || [ "$COMMAND" = "start" ] || [ "$COMMAND" = "restart" ] || [ "$COMMAND" = "bootstrap" ]
}

missing_dependencies() {
  echo "DEPENDENCIES_MISSING: 运行依赖尚未安装。修复：./sunabot.sh bootstrap" >&2
  exit 1
}

needs_install() {
  [ ! -f "$INSTALL_MARKER" ] || [ "$LOCK" -nt "$INSTALL_MARKER" ]
}

if [ -f "$RELEASE_MANIFEST" ]; then
  if [ -z "${SUNABOT_WORKSPACE:-}" ]; then
    INSTALL_ROOT=$(dirname -- "$(dirname -- "$ROOT")")
    SUNABOT_WORKSPACE="$INSTALL_ROOT/workspace"
    export SUNABOT_WORKSPACE
  fi
  if [ ! -x "$BUNDLED_NODE" ]; then
    echo "RELEASE_RUNTIME_MISSING: 发行包缺少内置 Node 运行时。" >&2
    exit 1
  fi
  if [ ! -f "$INSTALL_MARKER" ]; then
    echo "RELEASE_DEPENDENCIES_MISSING: 发行包缺少内置生产依赖。" >&2
    exit 1
  fi
  CURRENT=$($BUNDLED_NODE -p 'process.versions.node')
  if [ "$CURRENT" != "$VERSION" ]; then
    echo "RELEASE_RUNTIME_VERSION_MISMATCH: 需要 Node ${VERSION}，包内为 ${CURRENT}。" >&2
    exit 1
  fi
  PATH="$ROOT/runtime/node/bin:${PATH:-/usr/bin:/bin}"
  export PATH
  "$BUNDLED_NODE" --input-type=module -e '
    import fs from "node:fs/promises";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const root = process.argv[1];
    const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"));
    const integrity = await import(pathToFileURL(path.join(root, "tooling/runtime/release-integrity.mjs")));
    await integrity.validateReleaseManifest({ root, manifest });
  ' "$ROOT"
  if [ "$COMMAND" = "soul" ]; then
    shift
    exec "$BUNDLED_NODE" "$ROOT/tooling/agents/soul-cli.mjs" "$@"
  fi
  if [ "$COMMAND" = "upgrade-0.3.0" ]; then
    shift
    exec "$BUNDLED_NODE" "$ROOT/tooling/migrations/upgrade-0.2.0-to-0.3.0.mjs" "$@"
  fi
  exec "$BUNDLED_NODE" "$ROOT/tooling/runtime/launcher.mjs" "$@"
fi

if ! command -v fnm >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  ensure_macos_homebrew_path
fi

if command -v fnm >/dev/null 2>&1 && fnm exec --using="$VERSION" node -e "" >/dev/null 2>&1; then
  if [ "$COMMAND" = "upgrade-0.3.0" ]; then
    shift
    exec fnm exec --using="$VERSION" node "$ROOT/tooling/migrations/upgrade-0.2.0-to-0.3.0.mjs" "$@"
  fi
  if needs_install; then
    if allows_install; then
      echo "正在安装运行依赖..."
      (cd "$ROOT" && fnm exec --using="$VERSION" npm ci)
    else
      missing_dependencies
    fi
  fi
  ensure_macos_homebrew_path
  if [ "$COMMAND" = "soul" ]; then
    shift
    exec fnm exec --using="$VERSION" node "$ROOT/tooling/agents/soul-cli.mjs" "$@"
  fi
  exec fnm exec --using="$VERSION" node "$ROOT/tooling/runtime/launcher.mjs" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node ${VERSION}。请安装该版本后重试。" >&2
  exit 1
fi

CURRENT=$(node -p 'process.versions.node')
if [ "$CURRENT" != "$VERSION" ]; then
  echo "需要 Node ${VERSION}，当前为 ${CURRENT}。可执行：fnm install ${VERSION}" >&2
  exit 1
fi

if [ "$COMMAND" = "upgrade-0.3.0" ]; then
  shift
  exec node "$ROOT/tooling/migrations/upgrade-0.2.0-to-0.3.0.mjs" "$@"
fi

if needs_install; then
  if allows_install; then
    echo "正在安装运行依赖..."
    (cd "$ROOT" && npm ci)
  else
    missing_dependencies
  fi
fi

ensure_macos_homebrew_path
if [ "$COMMAND" = "soul" ]; then
  shift
  exec node "$ROOT/tooling/agents/soul-cli.mjs" "$@"
fi
exec node "$ROOT/tooling/runtime/launcher.mjs" "$@"
