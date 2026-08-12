#!/usr/bin/env bash
set -euo pipefail

REPOSITORY=${SUNABOT_GITHUB_REPOSITORY:-CatREFuse/sunabot}
VERSION=${SUNABOT_VERSION:-0.3.0}
PREFIX=${SUNABOT_INSTALL_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/sunabot}

usage() {
  cat <<'EOF'
用法：bash install.sh [--version <version>] [--prefix <directory>]

下载并校验 Sunabot 发行包，准备锁定的 NapCat 镜像，然后原子切换当前版本。
EOF
}

while (($#)); do
  case "$1" in
    --version)
      shift
      VERSION=${1:-}
      ;;
    --version=*) VERSION=${1#*=} ;;
    --prefix)
      shift
      PREFIX=${1:-}
      ;;
    --prefix=*) PREFIX=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不支持的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

VERSION=${VERSION#v}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || {
  echo "版本号无效：$VERSION" >&2
  exit 2
}
[[ $PREFIX = /* ]] || {
  echo "安装目录必须是绝对路径：$PREFIX" >&2
  exit 2
}

case "$(uname -s)" in
  Linux) platform=linux ;;
  *) echo "当前发行版支持 Linux 与 WSL2。" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) echo "当前架构不受支持：$(uname -m)" >&2; exit 1 ;;
esac

command -v curl >/dev/null 2>&1 || { echo "缺少 curl。" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "缺少 tar。" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "缺少 Docker，NapCat 无法运行。" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker Engine 未运行。" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 Docker Compose 插件。" >&2; exit 1; }

asset="sunabot-${VERSION}-${platform}-${architecture}.tar.gz"
base="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/sunabot-install.XXXXXXXX")
stage=
cleanup() {
  if [[ -n ${stage:-} && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT INT TERM

echo "正在下载 Sunabot ${VERSION}（${platform}/${architecture}）…"
curl --fail --location --silent --show-error "$base/$asset" -o "$scratch/$asset"
curl --fail --location --silent --show-error "$base/$asset.sha256" -o "$scratch/$asset.sha256"

expected=$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1; exit }' "$scratch/$asset.sha256")
[[ $expected =~ ^[a-f0-9]{64}$ ]] || { echo "发行校验文件无效。" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$scratch/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$scratch/$asset" | awk '{print $1}')
fi
[[ $actual == "$expected" ]] || { echo "发行包 SHA-256 校验失败。" >&2; exit 1; }

mkdir -p -- "$PREFIX/versions"
install_id=${scratch##*.}
stage="$PREFIX/versions/.install-${VERSION}-${install_id}"
target="$PREFIX/versions/${VERSION}-${actual:0:16}-${install_id}"
[[ ! -e $stage && ! -e $target ]] || { echo "安装目标已存在，请重试。" >&2; exit 1; }
mkdir -m 0755 -- "$stage"
tar -xzf "$scratch/$asset" -C "$stage"
[[ -f $stage/release-manifest.json && -x $stage/runtime/node/bin/node ]] || {
  echo "发行包缺少运行时文件。" >&2
  exit 1
}

"$stage/runtime/node/bin/node" -e 'process.exit(process.versions.node === "24.18.0" ? 0 : 1)' || {
  echo "发行包内置 Node 无法运行。" >&2
  exit 1
}
"$stage/runtime/node/bin/node" --input-type=module -e '
  import fs from "node:fs/promises";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const root = process.argv[1];
  const manifest = JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"));
  const integrity = await import(pathToFileURL(path.join(root, "tooling/runtime/release-integrity.mjs")));
  await integrity.validateReleaseManifest({ root, manifest });
' "$stage" || {
  echo "发行包完整性校验失败。" >&2
  exit 1
}
(cd "$stage" && "$stage/runtime/node/bin/node" --input-type=module -e \
  "await Promise.all([import('sharp'),import('@napi-rs/canvas'),import('officeparser')])") || {
  echo "发行包内置生产依赖无法运行。" >&2
  exit 1
}
codex_version=$("$stage/runtime/node/bin/node" \
  "$stage/node_modules/@openai/codex/bin/codex.js" --version 2>/dev/null) || {
  echo "发行包内置 Codex CLI 无法运行。" >&2
  exit 1
}
[[ $codex_version == "codex-cli 0.139.0" ]] || {
  echo "发行包内置 Codex CLI 版本无效。" >&2
  exit 1
}
"$stage/runtime/bubblewrap/bwrap" --version >/dev/null || {
  echo "发行包内置 Bubblewrap 无法在当前 Linux/WSL 环境运行。" >&2
  exit 1
}
LIGHTPANDA_DISABLE_TELEMETRY=true "$stage/runtime/lightpanda/lightpanda" version >/dev/null || {
  echo "发行包内置 Lightpanda 无法在当前 Linux/WSL 环境运行。" >&2
  exit 1
}

napcat_record=$(
  "$stage/runtime/node/bin/node" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const lock = JSON.parse(fs.readFileSync(path.join(root, "components/component.lock.json"), "utf8"));
    const component = lock.components.napcat;
    if (!component.version || !component.image || !component.digest) process.exit(2);
    process.stdout.write(`${component.version}\n${component.image}@${component.digest}`);
  ' "$stage"
)
napcat_version=${napcat_record%%$'\n'*}
napcat_ref=${napcat_record#*$'\n'}
if ! docker image inspect "$napcat_ref" >/dev/null 2>&1; then
  echo "正在准备 NapCat ${napcat_version} 运行镜像…"
  docker pull "$napcat_ref"
fi

mkdir -p -m 0700 -- "$PREFIX/workspace"
SUNABOT_WORKSPACE="$PREFIX/workspace" "$stage/sunabot.sh" bootstrap

mv -- "$stage" "$target"
stage=
link="$PREFIX/.current-$$"
ln -s -- "$target" "$link"
mv -Tf -- "$link" "$PREFIX/current"

cat <<EOF
Sunabot ${VERSION} 已安装。
启动命令：bash $PREFIX/current/sunabot.sh up
EOF
