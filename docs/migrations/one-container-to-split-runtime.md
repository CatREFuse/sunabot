# 旧单容器服务端切换备忘录

适用范围：WSL2/Linux 服务端已经拉取包含分离运行时的新代码，但当前生产仍由旧 `sunabot-qq-runtime` 容器运行。

目标：保留业务 workspace、双 SQLite、凭据和 NapCat 登录态，将运行形态切换为 Sunabot Core 与 NapCat 两个独立组件。旧容器保留为短期回滚载体。

服务端 Codex 发现旧容器后必须从本页“强制门禁”开始顺序执行，在完成离线备份和旧实例检查前不能运行 `./sunabot.sh up`。所有命令都在旧服务端本机执行，命令输出与备份位置应记录到本次升级任务。

## 强制门禁

- 整个切换窗口停止 QQ 服务。
- 旧容器停止并关闭自动重启后，才能执行 workspace 迁移或启动新运行时。
- 新运行时停止并确认端口释放后，才能回滚旧容器。
- 不删除旧容器、旧镜像、迁移前 workspace 归档和 SQLite 恢复点，直到新运行时完成至少 24 小时稳定运行与一次冷启动。
- 任一步无法确定 workspace、旧容器或备份完整性时停止操作，不创建第二套空 workspace。

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
test -d "$SUNABOT_WORKSPACE/business"
test -d "$SUNABOT_WORKSPACE/runtime/napcat"
test -f "$SUNABOT_WORKSPACE/business/data/sunabot.sqlite"
test -f "$SUNABOT_WORKSPACE/business/data/session-queue.sqlite"

export SUNABOT_WORKSPACE
printf 'legacy_container=%s\nworkspace=%s\n' "$LEGACY_CONTAINER" "$SUNABOT_WORKSPACE"

WORKSPACE_KIB="$(du -sk "$SUNABOT_WORKSPACE" | awk '{print $1}')"
AVAILABLE_KIB="$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')"
test "$AVAILABLE_KIB" -gt "$((WORKSPACE_KIB * 3))"
```

若任一命令或 `test` 失败，不继续。先处理 tracked worktree、Node、Docker、工具、磁盘空间、重复旧容器或 workspace 识别问题。未跟踪文件不会被该 Git 门禁删除，切换过程也不能执行 `git reset --hard` 或 `git clean`。

记录旧容器、镜像、挂载、环境变量名和当前代码：

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MIGRATION_BACKUP="${SUNABOT_MIGRATION_BACKUP:-$HOME/sunabot-pre-split-$STAMP}"
case "$MIGRATION_BACKUP/" in
  "$SUNABOT_WORKSPACE/"*) exit 1 ;;
esac
install -d -m 700 "$MIGRATION_BACKUP"
test "$(stat -c '%a' "$MIGRATION_BACKUP")" = "700"

git rev-parse HEAD > "$MIGRATION_BACKUP/new-code-commit.txt"
git reflog -n 20 > "$MIGRATION_BACKUP/git-reflog.txt"
docker inspect "$LEGACY_CONTAINER" > "$MIGRATION_BACKUP/legacy-container-inspect.json"
docker image inspect "$(docker inspect --format '{{.Image}}' "$LEGACY_CONTAINER")" \
  > "$MIGRATION_BACKUP/legacy-image-inspect.json"
```

## 2. 停止旧运行时

先停用可能重启旧容器的 systemd 包装单元：

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
docker stop --time 35 "$LEGACY_CONTAINER"

test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "false"
test -z "$(docker ps -q --filter 'label=com.docker.compose.service=qq-runtime')"
```

确认旧 Core 与 NapCat 没有继续监听：

```bash
if command -v ss >/dev/null 2>&1; then
  ! ss -ltnp | grep -E ':(8787|8788|6099)[[:space:]]'
fi
```

端口仍被占用时，用 `docker ps`、`ps` 和 `ss -ltnp` 找到遗留实例并停止；不得直接进入下一步。

## 3. 创建离线备份

安装新代码依赖，但不启动服务：

```bash
npm ci
```

创建并验证双 SQLite 一致恢复点：

```bash
npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced \
  --backup-root "$MIGRATION_BACKUP/sqlite-recovery"

SQLITE_BACKUP="$(find "$MIGRATION_BACKUP/sqlite-recovery" \
  -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"

test -n "$SQLITE_BACKUP"
npm run backup:verify -- --backup "$SQLITE_BACKUP"
```

归档业务目录、NapCat 配置与登录态、凭据：

```bash
tar -cpf "$MIGRATION_BACKUP/workspace-critical.tar" \
  -C "$SUNABOT_WORKSPACE" \
  business runtime/napcat secrets

sha256sum "$MIGRATION_BACKUP/workspace-critical.tar" \
  > "$MIGRATION_BACKUP/workspace-critical.tar.sha256"

(cd "$MIGRATION_BACKUP" && sha256sum -c workspace-critical.tar.sha256)
```

把 `$MIGRATION_BACKUP` 复制到当前服务器以外的受控存储。该目录含凭据与 QQ 登录态，必须加密传输和限制访问。

## 4. 执行 workspace 与 contract 迁移

```bash
npm run runtime:contract
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" npm run workspace:migrate
test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "false"
test -z "$(docker ps -q --filter 'label=com.docker.compose.service=qq-runtime')"
```

若 contract、迁移或旧容器门禁失败，保持旧容器停止，修复后重跑；不得启动任何一套服务绕过门禁。

## 5. 启动分离运行时

WSL2/Linux 默认使用 Docker Core：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh up
```

首次登录缺失时允许返回 `awaiting-login`。访问 `http://127.0.0.1:6099/webui` 完成 QQ 登录，然后执行：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

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

- 管理台只发布到 `127.0.0.1:8787`，NapCat WebUI 只发布到 `127.0.0.1:6099`。
- Docker Core 模式下 OneBot 只走 Compose 私有网络 `core:8788`，不发布宿主端口。
- OneBot access token 生效，只有一个 NapCat 连接。
- QQ 登录态保留；私聊、群聊、@、引用回复和 action 回包成功。
- 生成图片使用 `base64://`，消息中没有 `/srv/sunabot/workspace`、`/app/napcat` 等组件绝对路径。
- QQ 文件读取、Provider、记忆、异步任务和 outbox 恢复成功。
- 主库与 session queue 记录数符合迁移前恢复点，`integrity_check=ok`。
- `./sunabot.sh restart` 后 Core、NapCat、SQLite、QQ 登录态与 OneBot 自动恢复。

## 7. 回滚

任何数据完整性、重复实例、消息、图片、文件或重启验收失败时执行回滚。

停止新运行时并确认全部退出：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh down

if command -v ss >/dev/null 2>&1; then
  ! ss -ltnp | grep -E ':(8787|8788|6099)[[:space:]]'
fi
```

保留失败现场并恢复迁移前 workspace：

```bash
FAILED_WORKSPACE="$HOME/sunabot-failed-$STAMP"
mkdir -p "$FAILED_WORKSPACE"

mv "$SUNABOT_WORKSPACE/business" "$FAILED_WORKSPACE/business"
mv "$SUNABOT_WORKSPACE/secrets" "$FAILED_WORKSPACE/secrets"
mkdir -p "$FAILED_WORKSPACE/runtime" "$SUNABOT_WORKSPACE/runtime"
mv "$SUNABOT_WORKSPACE/runtime/napcat" "$FAILED_WORKSPACE/runtime/napcat"

tar -xpf "$MIGRATION_BACKUP/workspace-critical.tar" -C "$SUNABOT_WORKSPACE"
(cd "$MIGRATION_BACKUP" && sha256sum -c workspace-critical.tar.sha256)
```

恢复旧容器：

```bash
docker update --restart=unless-stopped "$LEGACY_CONTAINER"
docker start "$LEGACY_CONTAINER"
test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_CONTAINER")" = "true"
```

完成旧管理台、QQ 登录、文本、图片和 SQLite 检查。旧容器确认恢复前不重新运行 `./sunabot.sh up`。若旧容器已被误删，停止操作，使用保存的镜像 inspect、Git reflog、workspace 归档和 SQLite 恢复点重建旧版本；不能在现场猜测镜像或数据版本。
