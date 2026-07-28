#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(tr -d '[:space:]' < "$ROOT/.node-version")
LOCK="$ROOT/package-lock.json"
INSTALL_MARKER="$ROOT/node_modules/.package-lock.json"

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
  bootstrap   安装锁定的运行依赖与 Renderer 浏览器
  rollback-first-run  回滚未完成的首次运行
  help        显示帮助

选项：
  --core=auto|native|docker
  --dev
EOF
}

COMMAND=${1:-up}
case "$COMMAND" in
  -h|--help|help)
    usage
    exit 0
    ;;
  --core|--core=*|--dev)
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

if ! command -v fnm >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  ensure_macos_homebrew_path
fi

if command -v fnm >/dev/null 2>&1 && fnm exec --using="$VERSION" node -e "" >/dev/null 2>&1; then
  if needs_install; then
    if allows_install; then
      echo "正在安装运行依赖..."
      (cd "$ROOT" && fnm exec --using="$VERSION" npm ci)
    else
      missing_dependencies
    fi
  fi
  ensure_macos_homebrew_path
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

if needs_install; then
  if allows_install; then
    echo "正在安装运行依赖..."
    (cd "$ROOT" && npm ci)
  else
    missing_dependencies
  fi
fi

ensure_macos_homebrew_path
exec node "$ROOT/tooling/runtime/launcher.mjs" "$@"
