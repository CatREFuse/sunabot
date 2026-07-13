# 旧单容器服务端切换备忘录

版本：2026-07-14

适用范围：WSL2/Linux 服务端已经拉取包含统一 launcher、多 Agent 和多 QQ 的新代码，生产仍由旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service 运行。

切换目标：保留业务 workspace、全部 SQLite、凭据和 NapCat 登录态，切换为一个 Sunabot Core 与每个 QQ 账号一个独立 NapCat Docker 容器。旧容器保留为短期回滚载体。

发现旧容器后，必须从本页“强制门禁”开始顺序执行。完成离线归档、SQLite 恢复点和旧实例检查前，不得运行 `./sunabot.sh up`。所有命令在旧服务端本机执行，命令输出、代码 revision、备份路径和迁移报告都要记录到本次升级任务。

## 强制门禁

- 整个切换窗口停止 Core 和全部 QQ 服务。
- 旧容器停止并关闭自动重启后，才能创建恢复点、迁移 workspace 或启动新运行时。
- 新运行时停止并确认端口、容器和 Native Core 已退出后，才能回滚旧容器。
- 不删除旧容器、旧镜像、迁移前 workspace 归档和 SQLite 恢复点，直到新运行时完成至少 24 小时稳定运行与一次冷启动。
- 任一步无法确定 workspace、Agent 范围、旧容器或备份完整性时停止操作，不创建第二套空 workspace。
- `migrate:multi-agent` 成功后写入 `business/migrations/multi-agent-v1.json`，完成标记绑定恢复点 ID、恢复 manifest、迁移报告、源状态和目标注册信息。标记不能取代恢复点、迁移报告和现场记录，缺少任一项都不得清理旧容器与归档。

## 1. 预检并识别旧实例

在仓库根执行：

```bash
cd /srv/sunabot
umask 077

test "$(id -u)" -ne 0
test -z "$(git status --porcelain --untracked-files=no)"
test "$(node -p 'process.versions.node')" = "24.18.0"
docker info >/dev/null
docker compose version
command -v tar
command -v sha256sum
command -v install

LEGACY_IDS="$(
  docker ps -aq --filter 'name=^/sunabot-qq-runtime$'
  docker ps -aq --filter 'label=com.docker.compose.service=qq-runtime'
)"

LEGACY_IDS="$(printf '%s\n' "$LEGACY_IDS" | sed '/^$/d' | sort -u)"
test "$(printf '%s\n' "$LEGACY_IDS" | sed '/^$/d' | wc -l | tr -d ' ')" = "1"
LEGACY_CONTAINER="$LEGACY_IDS"
test -n "$LEGACY_CONTAINER"

SUNABOT_WORKSPACE="$(docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/srv/sunabot/workspace"}}{{.Source}}{{end}}{{end}}' \
  "$LEGACY_CONTAINER")"

test -n "$SUNABOT_WORKSPACE"
if test -f "$SUNABOT_WORKSPACE/business/data/sunabot.sqlite"; then
  test -f "$SUNABOT_WORKSPACE/business/data/session-queue.sqlite"
  test -d "$SUNABOT_WORKSPACE/runtime/napcat"
else
  test -f "$SUNABOT_WORKSPACE/artifacts/sunabot.sqlite"
  test -f "$SUNABOT_WORKSPACE/artifacts/session-queue.sqlite"
  test -d "$SUNABOT_WORKSPACE/napcat"
fi

export SUNABOT_WORKSPACE
printf 'legacy_container=%s\nworkspace=%s\n' "$LEGACY_CONTAINER" "$SUNABOT_WORKSPACE"

```

若任一命令或 `test` 失败，不继续。处理 tracked worktree、Node、Docker、工具、磁盘空间、重复旧容器或 workspace 识别问题。未跟踪文件不会被 Git 门禁删除，切换过程也不能执行 `git reset --hard` 或 `git clean`。

记录旧容器、镜像、挂载、环境变量名与当前代码：

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MIGRATION_BACKUP="${SUNABOT_MIGRATION_BACKUP:-$HOME/sunabot-pre-split-$STAMP}"
case "$MIGRATION_BACKUP/" in
  "$SUNABOT_WORKSPACE/"*) exit 1 ;;
esac
install -d -m 700 "$MIGRATION_BACKUP"
test "$(stat -c '%a' "$MIGRATION_BACKUP")" = "700"

WORKSPACE_KIB="$(du -sk "$SUNABOT_WORKSPACE" | awk '{print $1}')"
WORKSPACE_DEVICE="$(df -Pk "$SUNABOT_WORKSPACE" | awk 'NR == 2 {print $1}')"
BACKUP_DEVICE="$(df -Pk "$MIGRATION_BACKUP" | awk 'NR == 2 {print $1}')"
WORKSPACE_AVAILABLE_KIB="$(df -Pk "$SUNABOT_WORKSPACE" | awk 'NR == 2 {print $4}')"
BACKUP_AVAILABLE_KIB="$(df -Pk "$MIGRATION_BACKUP" | awk 'NR == 2 {print $4}')"
if test "$WORKSPACE_DEVICE" = "$BACKUP_DEVICE"; then
  test "$WORKSPACE_AVAILABLE_KIB" -gt "$((WORKSPACE_KIB * 3))"
else
  test "$WORKSPACE_AVAILABLE_KIB" -gt "$((WORKSPACE_KIB * 2))"
  test "$BACKUP_AVAILABLE_KIB" -gt "$((WORKSPACE_KIB * 2))"
fi

git rev-parse HEAD > "$MIGRATION_BACKUP/new-code-commit.txt"
git reflog -n 20 > "$MIGRATION_BACKUP/git-reflog.txt"
docker inspect "$LEGACY_CONTAINER" > "$MIGRATION_BACKUP/legacy-container-inspect.json"
docker image inspect "$(docker inspect --format '{{.Image}}' "$LEGACY_CONTAINER")" \
  > "$MIGRATION_BACKUP/legacy-image-inspect.json"
```

## 2. 停止旧运行时

下列 unit 名只用于清理历史服务器上已安装的自动重启单元。新发行包不再提供 NapCat systemd unit 或 runtime target，也不使用这些 unit 启动新系统。

```bash
for unit in sunabot-qq-runtime.service sunabot-runtime.target; do
  if systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q "^$unit"; then
    sudo systemctl disable --now "$unit"
  fi
done
```

关闭旧容器自动重启并停止容器：

```bash
docker update --restart=no "$LEGACY_CONTAINER"
docker stop --timeout 35 "$LEGACY_CONTAINER"

test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "false"
test -z "$(docker ps -q --filter 'label=com.docker.compose.service=qq-runtime')"

WORKSPACE_ID="$(node --input-type=module -e 'import {workspaceIdentity} from "./tooling/runtime/launcher-core.mjs"; console.log(workspaceIdentity(process.env.SUNABOT_WORKSPACE))')"
test -z "$(docker ps -q --filter "label=io.sunabot.workspace-id=$WORKSPACE_ID")"
```

确认旧 Core 与 NapCat 没有继续监听：

```bash
if command -v ss >/dev/null 2>&1; then
  ! ss -ltnp | grep -E ':(8787|8788|6099)[[:space:]]'
fi
```

最后一项检查覆盖当前 workspace 标签下的全部活动容器，包含 running、paused 与 restarting；Docker 状态无法读取或端口仍被占用时，使用 `docker ps`、`ps` 和 `ss -ltnp` 找到真实所有者并停止。不得直接进入下一步。

## 3. 创建原始布局离线归档

安装新代码依赖，不启动服务：

```bash
npm ci
npm run runtime:contract
```

在任何 workspace 或 schema 迁移前，按现场实际布局归档业务目录、NapCat 配置与登录态、凭据：

```bash
(
  cd "$SUNABOT_WORKSPACE"
  ARCHIVE_PATHS=()
  for entry in business runtime/napcat secrets config agents artifacts security napcat .env; do
    test ! -e "$entry" || ARCHIVE_PATHS+=("$entry")
  done
  test "${#ARCHIVE_PATHS[@]}" -gt 0
  tar -cpf "$MIGRATION_BACKUP/workspace-critical.tar" "${ARCHIVE_PATHS[@]}"
)

sha256sum "$MIGRATION_BACKUP/workspace-critical.tar" \
  > "$MIGRATION_BACKUP/workspace-critical.tar.sha256"

(cd "$MIGRATION_BACKUP" && sha256sum -c workspace-critical.tar.sha256)
```

原始归档必须在旧布局仍存在时完成；它是 workspace 布局迁移的回滚依据，不能用后续 SQLite 恢复点代替。

把 `$MIGRATION_BACKUP` 复制到当前服务器以外的受控存储。该目录含凭据与 QQ 登录态，必须加密传输并限制访问。

## 4. 按固定顺序迁移数据与结构

全程保持旧容器停止：

```bash
test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "false"
test -z "$(docker ps -q --filter 'label=com.docker.compose.service=qq-runtime')"
test -z "$(docker ps -q --filter "label=io.sunabot.workspace-id=$WORKSPACE_ID")"
```

先执行 workspace 布局迁移。该命令支持旧 `config/agents/artifacts/security/napcat/.env` 布局，并在 workspace 内创建带哈希的布局备份：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" npm run workspace:migrate
```

规范双库路径出现后，立即在任何 schema 或业务数据迁移前创建并复验 SQLite 恢复点：

```bash
npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced \
  --backup-root "$MIGRATION_BACKUP/pre-migration-recovery"

PRE_MIGRATION_BACKUP="$(find "$MIGRATION_BACKUP/pre-migration-recovery" \
  -mindepth 1 -maxdepth 1 -type d \
  ! -name '.partial-*' | sort | tail -n 1)"

test -n "$PRE_MIGRATION_BACKUP"
npm run backup:verify -- --backup "$PRE_MIGRATION_BACKUP"
```

恢复工具 v2 会识别尚无 Agent 注册表的旧单 Agent 数据库，并将它按 Plana 双库处理。如果数据库已有注册表，manifest v2 必须覆盖注册表中全部启用或停用 Agent。备份会对注册缺库、单边数据库和未注册孤儿库失败关闭。

恢复点通过后，继续执行旧 JSON/JSONL 持久化和多 Agent 迁移：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" npm run migrate:sqlite

npm run migrate:multi-agent -- \
  --workspace "$SUNABOT_WORKSPACE"
```

dry-run 的 `state` 为 `ready` 时才执行：

```bash
npm run migrate:multi-agent -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --backup-root "$MIGRATION_BACKUP/multi-agent-recovery" \
  --apply \
  --quiesced
```

保存成功 JSON 中的 `recoveryPoint` 和 `reportPath`，然后复验该恢复点与 `single-agent-to-multi-agent.json`。

dry-run 返回 `already-migrated` 表示完成标记、全部 Agent 的规范 workspace、manifest 与必需双库、全部 QQ 的注册关系和运行目录、Plana/primary 基线，以及标记目标的 workspace 与端口已经通过校验；仍需查找标记绑定的恢复点与迁移报告并完成现场复验。结构已经就绪但缺少标记时会返回 `ready`，必须保持停服并执行 apply，不能把应用创建的 schema 视为迁移完成证据。报告验收按 [单 Agent 到多 Agent 迁移备忘录](./single-agent-to-multi-agent.md) 的四类 copied/preserved 证据执行。

数据和结构完成后，在停服状态创建新的全 Agent 恢复点：

```bash
npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced \
  --backup-root "$MIGRATION_BACKUP/post-migration-recovery"

POST_MIGRATION_BACKUP="$(find "$MIGRATION_BACKUP/post-migration-recovery" \
  -mindepth 1 -maxdepth 1 -type d \
  ! -name '.partial-*' | sort | tail -n 1)"

test -n "$POST_MIGRATION_BACKUP"
npm run backup:verify -- --backup "$POST_MIGRATION_BACKUP"
```

新 manifest v2 中的 Agent 集合、数据库数量和源路径必须与 Plana 注册主库一致。

把新增的迁移前恢复点、迁移报告和迁移后恢复点同步到第 3 步的受控异机存储，并在异机副本上再次执行 `sha256sum -c workspace-critical.tar.sha256` 与两次 `backup:verify`。异机副本复验完成前，不能把本机 `$MIGRATION_BACKUP` 视为唯一恢复依据。

## 5. 启动分离运行时

WSL2/Linux 默认使用 Docker Core：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh up
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

Launcher 从 `agent_accounts` 读取已启用账号，为每个账号启动独立 NapCat 容器并分配自己的 WebUI 端口。首个 primary 账号默认使用 `6099`。

登录态失效时，在管理台 Agent 页对相应账号扫码。NapCat 原生 WebUI 按 `status` 输出的 `http://127.0.0.1:<webuiPort>/webui` 用于诊断。

## 6. 切换验收

确认旧服务没有运行：

```bash
test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "false"
test -z "$(docker ps -q --filter 'label=com.docker.compose.service=qq-runtime')"
```

确认新组件和本机入口：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
curl --fail --silent --show-error http://127.0.0.1:8787/api/auth/session >/dev/null
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

逐项实测：

- 管理台只发布到 `127.0.0.1:8787`，每个 NapCat WebUI 只发布到自己的宿主回环端口。
- Docker Core 模式下 OneBot 只通过 Compose 私有网络访问 `core:8788`，不向宿主或局域网发布。
- OneBot access token 生效，每个已启用 QQ 对应一个携带 `account_id` 的活动连接。
- 管理台中 Plana、primary、原人格、公共提示词、会话、记忆、图片历史和 Token 统计与迁移前一致。
- 每个 Agent 只读写自己的业务库、队列库、人格和图片，全 Agent 统计只做聚合。
- 每个 QQ 的登录态保留；私聊、群聊、@、引用回复和 action 回包从原账号定向返回。
- 生成图片使用 `base64://`，消息中没有 `/srv/sunabot/workspace`、`/app/napcat` 等跨组件绝对路径。
- QQ 文件读取、Provider、记忆、异步任务和 outbox 恢复成功。
- 迁移后 manifest v2 中全部 Agent 数据库 `integrity_check=ok`，外键、记录数和队列投递不变量与切换前证据一致。
- `./sunabot.sh restart` 后 Core、全部 NapCat、SQLite、QQ 登录态与 OneBot 自动恢复。
- 服务器冷启动后再执行 `./sunabot.sh up`，上述状态仍成立。

## 7. 回滚

任何数据完整性、重复实例、Agent 隔离、账号路由、消息、图片、文件或冷启动验收失败时执行回滚。

停止新运行时并确认全部退出：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh down

if command -v ss >/dev/null 2>&1; then
  ! ss -ltnp | grep -E ':(8787|8788|6099)[[:space:]]'
fi

```

保留失败现场，用迁移前归档恢复整个关键 workspace：

```bash
FAILED_WORKSPACE="$HOME/sunabot-failed-$STAMP"
mv "$SUNABOT_WORKSPACE" "$FAILED_WORKSPACE"
install -d -m 700 "$SUNABOT_WORKSPACE"

tar -xpf "$MIGRATION_BACKUP/workspace-critical.tar" \
  -C "$SUNABOT_WORKSPACE"

(cd "$MIGRATION_BACKUP" && sha256sum -c workspace-critical.tar.sha256)
npm run backup:verify -- --backup "$PRE_MIGRATION_BACKUP"
```

`PRE_MIGRATION_BACKUP` 如果原本位于迁移备份根外，要改为恢复后的实际路径。必要时先将恢复点还原到空的隔离 workspace，完成 `backup:restore` 演练后再处理现场。

恢复旧容器：

```bash
docker update --restart=unless-stopped "$LEGACY_CONTAINER"
docker start "$LEGACY_CONTAINER"
test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "true"
```

完成旧管理台、QQ 登录、文本、图片和 SQLite 检查。旧容器确认恢复前不重新运行 `./sunabot.sh up`。如果旧容器已被误删，停止操作，使用保存的镜像 inspect、Git reflog、workspace 归档和 SQLite 恢复点重建旧版本，不在现场猜测镜像或数据版本。
