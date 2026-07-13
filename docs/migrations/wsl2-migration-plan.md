# sunabot WSL2 部署与迁移

日期：2026-07-14

目标：在 Windows WSL2 中通过统一 launcher 运行一个 Sunabot Core 和多个按 QQ 账号隔离的 NapCat Docker 容器，完整保留全 Agent 业务数据、队列、凭据和 QQ 登录态。

## 1. 支持范围

推荐 Ubuntu 24.04 WSL2。仓库与 workspace 放在 WSL ext4 文件系统，例如 `/srv/sunabot` 和 `/srv/sunabot-workspace`，不放在 `/mnt/c`。Windows Native 不在当前支持范围。

| Windows 主机 | Docker 方案 |
| --- | --- |
| Windows 11 | Docker Desktop WSL2 后端，为目标发行版开启 WSL Integration |
| Windows Server 2022/2025 | 在 Ubuntu WSL2 内安装 Docker Engine 与 Compose 插件 |

Docker Desktop 的 Windows 支持范围以[Docker 官方文档](https://docs.docker.com/desktop/setup/install/windows-install/)为准；Windows Server 的 WSL 安装以[Microsoft 官方文档](https://learn.microsoft.com/en-us/windows/wsl/install-on-server)为准。

`deploy/runtime-contract.json` 当前只开放 `linux/amd64`。ARM Windows 主机或 ARM WSL 环境不能跳过架构门禁。

## 2. 运行形态

NapCat 始终运行在 Docker 中。WSL2 中的 Core 有两种模式：

```bash
# 默认：Docker Core + 每账号一个 NapCat Docker
./sunabot.sh up

# 可选：WSL Native Core + 每账号一个 NapCat Docker
SUNABOT_CORE_MODE=native ./sunabot.sh up
```

Docker Core 通过 Compose 私有网络接收 OneBot；Native Core 由 launcher 选择容器可达的 WSL 网关。两种模式共用 OneBot token、Agent 注册表、SQLite schema、workspace 和 `base64://` 媒体契约。

每个已启用 QQ 账号都对应一个独立 NapCat 容器、`runtime/napcat/accounts/<accountId>/` 目录和 WebUI 端口。首个账号默认使用 `6099`，后续账号使用注册表分配的端口。

## 3. WSL2 环境准备

管理员 PowerShell：

```powershell
wsl.exe --install -d Ubuntu-24.04
wsl.exe --update
wsl.exe -l -v
```

Ubuntu WSL2 的基础依赖：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git build-essential python3 tar gnupg
```

安装仓库 `.node-version` 指定的 Node.js `24.18.0`。Windows 11 使用 [Docker Desktop WSL2 后端](https://docs.docker.com/desktop/features/wsl/)；Windows Server 按 [Docker Engine Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)安装 Engine、Buildx 与 Compose 插件。

```bash
node --version
docker version
docker compose version
docker run --rm hello-world
```

Docker Core 的 Codex CLI `0.139.0`、bubblewrap 和 LibreOffice 由 Core 镜像提供并在构建或启动时检查。如使用 WSL Native Core，宿主环境还要准备：

```bash
sudo apt install -y bubblewrap libreoffice fonts-noto-cjk
npm install -g @openai/codex@0.139.0
bwrap --version
codex --version
libreoffice --version
```

Native Core 的 `workspace_bash` 在 bubblewrap 缺失或 namespace probe 失败时会安全拒绝，不能改成普通 Bash 降级运行。Codex CLI 版本不匹配时 Core 不应启动。

## 4. 新实例安装

由将持有仓库和 workspace 的非 root 用户执行：

```bash
sudo mkdir -p /srv/sunabot
sudo chown "$USER:$USER" /srv/sunabot
git clone https://github.com/CatREFuse/sunabot.git /srv/sunabot
cd /srv/sunabot
npm ci
npm run runtime:contract
./sunabot.sh up
./sunabot.sh doctor
./sunabot.sh status
```

首次交互式启动会要求设置管理员凭据。无 TTY 环境要在启动前执行：

```bash
npm run workspace:init
ADMIN_PASSWORD_FILE=/run/secrets/sunabot-admin-password
test -f "$ADMIN_PASSWORD_FILE"
test "$(stat -c '%a' "$ADMIN_PASSWORD_FILE")" = "600"
npm run admin:set-password -- admin < "$ADMIN_PASSWORD_FILE"
./sunabot.sh up
./sunabot.sh doctor
./sunabot.sh status
```

密码文件由受控 secret manager 或部署流程创建，只允许部署用户读取，命令成功后按凭据管理策略销毁临时副本；空 stdin 会被拒绝。

管理台固定为 `http://127.0.0.1:8787`。在 Agent 管理页为 Plana 的 primary 账号完成扫码，再配置 Provider 并进行真实模型请求检查。NapCat 原生 WebUI 只作故障诊断入口。

## 5. 迁移现有实例

### 5.1 判定迁移路径

- 发现旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service：必须完整执行 [旧单容器切换备忘录](./one-container-to-split-runtime.md)。
- 现有 workspace 仍为单 Agent 结构：在首次 `./sunabot.sh up` 前执行 [单 Agent 到多 Agent 迁移备忘录](./single-agent-to-multi-agent.md)。
- 现有实例已经是当前多 Agent 结构且 `business/migrations/multi-agent-v1.json` 校验有效：使用下面的全 Agent 离线转移流程。

旧实例不得先启动新 Core 再判断是否需要迁移。launcher 会在 workspace 初始化与 Agent 注册写入前校验 `business/migrations/multi-agent-v1.json`；主库出现后核对全部 Agent 的规范 workspace、manifest 与必需双库、全部 QQ 的注册关系和运行目录、Plana/primary 基线，完成标记还绑定迁移目标 workspace 与端口。缺少标记或任何完整状态不一致时直接停止。操作者仍要保留 dry-run、迁移前恢复点、迁移报告、完成标记和迁移后恢复点作为切换证据。

### 5.2 源机停服与全 Agent 恢复点

在源机仓库根执行：

```bash
export SUNABOT_WORKSPACE=/absolute/path/to/workspace
cd /srv/sunabot
./sunabot.sh down
./sunabot.sh status

WORKSPACE_ID="$(node --input-type=module -e 'import {workspaceIdentity} from "./tooling/runtime/launcher-core.mjs"; console.log(workspaceIdentity(process.env.SUNABOT_WORKSPACE))')"
test -z "$(docker ps -q --filter "label=io.sunabot.workspace-id=$WORKSPACE_ID")"

npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced
```

容器检查必须覆盖当前 workspace 标签下的全部活动容器，包含 running、paused 与 restarting；Docker 状态无法读取时停止迁移，不能创建“已停服”的恢复点证据。

从 JSON 输出记录 `backupDirectory`，再复验：

```bash
export SQLITE_BACKUP=/absolute/path/from/backupDirectory
npm run backup:verify -- --backup "$SQLITE_BACKUP"
```

manifest v2 必须包含 Plana 与注册表中全部启用或停用 Agent 的业务库和队列库。注册缺库、单边数据库、未注册孤儿库或路径问题会让创建失败；不能删除问题数据目录继续迁移。

### 5.3 完整 workspace 归档

在 Core 和全部 NapCat 保持停止时归档：

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TRANSFER_ROOT="$HOME/sunabot-wsl2-transfer-$STAMP"
install -d -m 700 "$TRANSFER_ROOT"

if [[ -d .git ]]; then
  test -z "$(git status --porcelain --untracked-files=no)"
  SOURCE_COMMIT="$(git rev-parse HEAD)"
else
  test -f release-manifest.json
  SOURCE_COMMIT="$(node -p 'require("./release-manifest.json").sourceCommit')"
fi
SOURCE_VERSION="$(node -p 'require("./package.json").version')"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
printf 'SOURCE_COMMIT=%s\nSOURCE_VERSION=%s\n' \
  "$SOURCE_COMMIT" "$SOURCE_VERSION" > "$TRANSFER_ROOT/source-code.env"
chmod 600 "$TRANSFER_ROOT/source-code.env"

RAW_ARCHIVE="$TRANSFER_ROOT/.workspace-critical.tar"
ENCRYPTED_ARCHIVE="$TRANSFER_ROOT/workspace-critical.tar.gpg"
trap 'rm -f "$RAW_ARCHIVE"' EXIT

tar -cpf "$RAW_ARCHIVE" \
  -C "$SUNABOT_WORKSPACE" \
  business runtime/napcat secrets backups/sqlite-recovery

gpg --symmetric --cipher-algo AES256 \
  --output "$ENCRYPTED_ARCHIVE" \
  "$RAW_ARCHIVE"
rm -f "$RAW_ARCHIVE"
trap - EXIT

(
  cd "$TRANSFER_ROOT"
  sha256sum workspace-critical.tar.gpg source-code.env > transfer.sha256
  sha256sum -c transfer.sha256
)
```

归档包含 API 凭据、管理凭据、QQ 登录态和业务数据。只传输 `workspace-critical.tar.gpg`、`source-code.env` 与 `transfer.sha256`；GPG 口令通过独立受控通道交付，不能写入仓库、命令参数、传输目录或任务日志。目标机复验密文和 revision 元数据后才允许解密。`workspace/cache/`、`workspace/runtime/logs/`、PID、临时文件、`node_modules/` 和 `dist/` 可重建，不需要转移。

源机保持停机，不要在源机和目标机同时登录任一 QQ，也不要让两台机器写入同一个同步目录。

### 5.4 目标机恢复

```bash
TRANSFER_SOURCE=/secure/path/to/transferred-directory
(cd "$TRANSFER_SOURCE" && sha256sum -c transfer.sha256)

cd /srv/sunabot
SOURCE_COMMIT="$(sed -n 's/^SOURCE_COMMIT=//p' "$TRANSFER_SOURCE/source-code.env")"
SOURCE_VERSION="$(sed -n 's/^SOURCE_VERSION=//p' "$TRANSFER_SOURCE/source-code.env")"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
if [[ -d .git ]]; then
  test -z "$(git status --porcelain --untracked-files=no)"
  TARGET_COMMIT="$(git rev-parse HEAD)"
else
  test -f release-manifest.json
  TARGET_COMMIT="$(node -p 'require("./release-manifest.json").sourceCommit')"
fi
TARGET_VERSION="$(node -p 'require("./package.json").version')"
test "$TARGET_COMMIT" = "$SOURCE_COMMIT"
test "$TARGET_VERSION" = "$SOURCE_VERSION"

sudo mkdir -p /srv/sunabot-workspace
sudo chown "$USER:$USER" /srv/sunabot-workspace
chmod 700 /srv/sunabot-workspace

RESTORE_ARCHIVE="/srv/.sunabot-workspace-restore-$$.tar"
umask 077
trap 'rm -f "$RESTORE_ARCHIVE"' EXIT
gpg --output "$RESTORE_ARCHIVE" \
  --decrypt "$TRANSFER_SOURCE/workspace-critical.tar.gpg"
tar -xpf "$RESTORE_ARCHIVE" \
  -C /srv/sunabot-workspace
rm -f "$RESTORE_ARCHIVE"
trap - EXIT

export SUNABOT_WORKSPACE=/srv/sunabot-workspace
chmod 700 "$SUNABOT_WORKSPACE/secrets"
chmod 600 "$SUNABOT_WORKSPACE/secrets/runtime.env"
```

在启动前复验转移过来的恢复点，并从 manifest 逐项核对 Agent 范围：

```bash
npm run backup:verify -- --backup "$SQLITE_BACKUP"
npm run runtime:contract
./sunabot.sh doctor
```

这里的 `SQLITE_BACKUP` 必须改为目标机上的实际路径。恢复点复验失败、Agent 范围不一致、密文与元数据 SHA-256 不匹配，或目标代码 commit/version 与源机记录不一致时不能启动。解密产生的临时明文归档必须在解包后删除；异常退出由 `trap` 清理。

## 6. 启动、登录与账号扩展

```bash
cd /srv/sunabot
export SUNABOT_WORKSPACE=/srv/sunabot-workspace
./sunabot.sh up
./sunabot.sh status
./sunabot.sh doctor
```

启动器从 `agent_accounts` 读取已启用账号，逐个启动 NapCat 容器。一个账号等待扫码不代表其他账号的登录态可以共用。

管理台的 Agent 页会按账号显示登录状态。需要原生 WebUI 诊断时，按 `./sunabot.sh status` 输出访问：

```text
http://127.0.0.1:<webuiPort>/webui
```

在管理台新增 QQ 账号后，当前要执行一次：

```bash
./sunabot.sh restart
```

重启后 launcher 会为新账号建立独立容器和端口映射，随后才能扫码。

Windows 与 WSL localhost 转发异常时，修复 WSL 或 Docker 集成。管理 listener 不能为了绕过转发问题改成 `0.0.0.0`。OneBot `8788` 也不能直接发布到 Windows、局域网或公网。

## 7. 验收

| 检查 | 验收结果 |
| --- | --- |
| 运行所有权 | 同一 workspace 只有一个 Core，无旧 `qq-runtime` 并行容器，`doctor` 无所有权冲突 |
| Node 与 Docker | Node `v24.18.0`，Docker Engine 与 Compose 可用，镜像架构为 `linux/amd64` |
| Agent 双库 | Plana 与其他 Agent 的业务库、queue 都在 manifest v2 中，`integrity_check=ok`，队列不变量一致 |
| 管理台 | `127.0.0.1:8787` 可登录，Agent 切换、设置、对话、记忆和图片按 Agent 隔离 |
| NapCat 账号 | 每个已启用 QQ 都有独立容器、目录、WebUI 端口和登录态 |
| OneBot | 专用 `8788`、token 校验、`account_id` 路由、两个 QQ 同时在线和定向 action 通过 |
| 媒体 | 图片使用 `base64://`，消息与数据库中没有跨组件绝对路径 |
| 文件 | QQ 文件可读，NapCat 容器路径不会被 Core 直接打开 |
| 工具 | Provider、websearch、图像、自拍、Codex 和 `workspace_bash` 符合当前 Core 模式的能力门控 |
| 重启 | `./sunabot.sh restart` 后所有 Agent SQLite、outbox、QQ 登录态和 OneBot 连接恢复 |
| 冷启动 | Windows 重启并启动 WSL/Docker 后，执行同一 `./sunabot.sh up` 恢复服务 |

`status` 和 `doctor` 的通过只是基础运行证据。切换验收还要实测每个账号的私聊、群聊、引用回复、图片、文件、定向外发和冷启动。

## 8. 回滚

1. 目标机验收完成前，源机保持停机且不删除原 workspace、代码 revision 或容器。
2. 目标失败时执行 `./sunabot.sh down`，确认 Core、全部 NapCat 和端口已停止。
3. 保留目标失败现场，用转移归档恢复 workspace，并在空的隔离目录执行 `backup:restore` 演练和复验。
4. 目标 workspace 回到与代码 revision 匹配的结构后，重新执行 `runtime:contract`、`doctor` 和完整验收。
5. 如果决定切回源机，目标机继续保持停止，只在源机恢复代码、workspace 和原启动方式。

任何时刻都不能让源机与目标机同时连接同一 QQ 或写入同一份业务数据。
