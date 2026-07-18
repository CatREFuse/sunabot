# 单 Agent 到多 Agent 迁移备忘录

版本：2026-07-14

## 适用范围

本文用于把已有单 Agent Sunabot 工作区迁移到当前多 Agent、多 QQ 结构。迁移目标固定为：

| 旧数据 | 迁移后归属 |
| --- | --- |
| 原 Agent 的会话、记忆、图片历史、请求日志与 Token 统计 | `plana` |
| 原主库 | `workspace/business/data/sunabot.sqlite`，路径保持不变 |
| 原会话队列库 | `workspace/business/data/session-queue.sqlite`，路径保持不变 |
| 原 QQ 接入 | `primary` |
| 原 NapCat 配置与 QQ 登录态 | 复制到 `workspace/runtime/napcat/accounts/primary/` |
| 原单账号环境变量 `NAPCAT_ACCOUNT` | 回填到 `agent_accounts.qq_id` 和 `accounts/primary/account.env`；迁移后不再作为全局账号配置 |
| 原 Bot 行为 | 写入或继续保留在 Plana `agent.json` |
| 原人格提示词 | 继续保留在 `workspace/business/agents/plana/` |
| 原系统提示词 | 无覆盖复制到 `workspace/business/prompts/`，作为所有 Agent 的公共默认版本；仅有旧 `conversation_reply.json` 时，同时作为缺失的私聊与群聊回复提示词来源 |
| Provider、模型与共用开关 | 继续使用 `workspace/business/config/sunabot.json` |

迁移不会把旧主库搬进 `business/agents/plana/data/`，也不会删除旧 NapCat 目录。新增 Agent 才使用 `workspace/business/agents/<agentId>/data/` 中的独立主库与队列库。

## 安全边界

- 必须由拥有仓库和 workspace 的非 root 用户执行。
- 实际迁移要求 Sunabot Core 与 NapCat 全部停止，并通过 `--quiesced` 明确确认。
- 执行前必须先保存迁移前原始布局；规范双库已经存在时使用恢复工具 v2 创建离线一致恢复点。旧布局要先完成受控离线归档，再执行 workspace 布局迁移，随后立即创建恢复点，不能在恢复点前运行会删除旧来源的 JSON/JSONL 持久化迁移。恢复点包含 checkpoint、独占锁、SHA-256、`integrity_check`、外键和队列投递不变量校验。标准旧单 Agent 库没有注册表时，工具将它作为 Plana 双库处理；如果已有注册表，恢复点必须同时覆盖注册表中全部启用或停用 Agent 的双库。
- 旧业务表逐表核对记录数。Agent 注册表、schema metadata 和可重建统计聚合表允许向前迁移。
- NapCat 状态只做无覆盖复制；目标存在不同内容时终止。
- 系统提示词只做无覆盖复制；`business/prompts/` 中存在同名但哈希不同的文件时终止。
- 已具备完整 Plana/primary 注册、manifest 和账号运行目录的当前结构以 `business/prompts/` 为公共提示词真值；封存缺失标记时保留现有公共版本，并在报告中记录旧源与当前目标两侧哈希。
- 迁移失败不会自动恢复数据库。恢复点路径会写入错误详情和迁移报告，避免未经确认覆盖现场。
- 自动脚本只支持规范数据库路径。外部主库覆盖已经退役；进程环境或 `workspace/secrets/runtime.env` 中出现 `SUNABOT_DATABASE_PATH` 时会以 `CUSTOM_DATABASE_PATH_UNSUPPORTED` 终止，必须先把数据库按单独验证的迁移方案归位到 `workspace/business/data/sunabot.sqlite` 并清除该变量。
- manifest v2 会拒绝注册 Agent 缺库、业务库与 queue 单边存在、未注册孤儿库、非法 Agent ID、符号链接和路径越界。不得删除问题目录继续迁移。
- 历史 manifest v1 仍可校验和恢复，它只代表 Plana 双库范围，不能作为多 Agent workspace 的完整备份证据。

## 启动门禁

workspace 初始化、launcher、probe、API 组合根、AgentRegistry 和迁移器会在任何业务写入前逐级校验 workspace 完整父目录链，并校验 `business/migrations/multi-agent-v1.json`。真正空目录会先原子写入 `fresh-install` 标记；主库尚未出现时只允许受控 marker 目录和临时文件，主库出现后 fresh 与 completed 状态都必须校验完整注册集合。完整集合包含规范主双库、每个 Agent 的规范 workspace 与 manifest、全部非 Plana Agent 的双库、每个 QQ 的 Agent 归属、唯一 WebUI 端口和 `config-full/qq/plugins` 目录，以及 Plana/primary 基线与 primary `6099` 端口；所有必需路径逐段拒绝符号链接。完成标记额外核对迁移目标 workspace 和端口。任何缺失、摘要或格式无效、注册状态漂移与符号链接都会稳定拒绝且不补建当前结构。

现有单 Agent workspace 在首次启动新代码前，必须人工完成本文的 dry-run、停服 apply、恢复点与迁移报告复验。结构已经就绪但缺少标记时，dry-run 仍返回 `ready`，apply 会重新创建恢复点并写入完成标记；只有完成标记及其目标状态全部通过校验时才返回 `already-migrated`。

## 迁移前确认

设置当前部署使用的绝对 workspace：

```bash
export SUNABOT_WORKSPACE=/absolute/path/to/workspace
test -d "$SUNABOT_WORKSPACE"
node --version
```

Node 版本必须与源码仓库 `.node-version` 或发行包 `release-manifest.json` 一致。源码安装记录 Git revision；解压发行包记录 schema v2 manifest，不要求 `.git`：

```bash
if [[ -d .git ]]; then
  git status --short
  git rev-parse HEAD
else
  test -f release-manifest.json
  node -e 'const m=require("./release-manifest.json"); console.log(JSON.stringify({schemaVersion:m.schemaVersion,releaseVersion:m.releaseVersion,nodeVersion:m.nodeVersion,platform:m.platform,sourceCommit:m.sourceCommit,integrityFiles:Object.keys(m.integrity?.files || {}).length}))'
fi
./sunabot.sh status
docker ps -a --format '{{.Names}}\t{{.Status}}'
df -h "$SUNABOT_WORKSPACE"
```

发行包迁移 wrapper 会在执行前核对真实 Linux/x64、runtime contract、版本、Node、source commit，以及完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件的文件集合和 SHA-256；任一受保护文件缺失、新增、符号链接化或内容变化都会停止迁移。npm 生成且迁移不会执行的 `.bin` 命令链接不进入清单，其他符号链接全部拒绝。

发现旧 `sunabot-qq-runtime` 容器或旧 `qq-runtime` Compose service 时，同时遵守 [单容器到分离运行时迁移备忘录](./one-container-to-split-runtime.md)。完成其中的停服、离线双库备份和 workspace 布局迁移后，在启动新运行时前执行本文的多 Agent 迁移。

## 预检

命令默认对 workspace 业务数据执行只读 dry-run，可以在停服前查看计划。源码 checkout 的 wrapper 会先重新构建忽略出库的 `dist/`，因此应从无其他构建任务的干净源码目录执行；发行包直接使用已校验构建：

```bash
npm run migrate:multi-agent -- --workspace "$SUNABOT_WORKSPACE"
```

正常的待迁移结果包含：

```json
{
  "ok": true,
  "mode": "dry-run",
  "state": "ready",
  "target": {
    "agentId": "plana",
    "accountId": "primary",
    "agentWorkspace": "workspace/business/agents/plana",
    "webuiPort": 6099
  }
}
```

`state` 为 `already-migrated` 时表示完成标记、全部 Agent manifest 与必需双库、注册表中的全部账号运行目录、Plana/primary 基线，以及标记目标的 workspace 和端口已经通过校验。继续核对标记绑定的恢复点与迁移报告；证据缺失时停止切换并查明来源。结构已经就绪但没有完成标记时会返回 `ready`，仍需在停服状态执行 apply。

预检可能要求完成旧格式的前置迁移：

| 错误码 | 处理 |
| --- | --- |
| `WORKSPACE_LAYOUT_MIGRATION_REQUIRED` | 按下文停服、保存原始布局，再运行 `npm run workspace:migrate` |
| `SQLITE_MIGRATION_REQUIRED` | 按下文停服、归档旧来源并创建规范双库恢复点，再运行 `npm run migrate:sqlite` |
| `SOURCE_DATABASE_MISSING` | 核对 workspace，禁止用空库替代旧库 |
| `DEFAULT_AGENT_UNSUPPORTED` | 核对旧配置，自动流程只接收默认 `plana` |
| `MIGRATION_TARGET_CONFLICT` | 比较报告中的目标文件与旧 NapCat 状态，保留两份后人工决定 |
| `SYSTEM_PROMPT_TARGET_CONFLICT` | 比较 Plana 原提示词与 `business/prompts/` 同名文件，确认保留版本后再执行 |
| `SYSTEM_PROMPT_PATH_INVALID` | 修正配置中的提示词相对路径，禁止使用绝对路径或 `..` |
| `LEGACY_ACCOUNT_IDENTITY_CONFLICT` | 核对旧 `NAPCAT_ACCOUNT`、primary 注册 QQ 和账号环境文件 |
| `CUSTOM_DATABASE_PATH_UNSUPPORTED` | 清除进程与 `workspace/secrets/runtime.env` 中的覆盖变量，并按受控方案把旧库归位到规范路径 |

只要预检要求 workspace 布局或 JSON/JSONL 前置迁移，就使用同一恢复顺序。已是当前布局时跳过 `workspace:migrate`；没有 `SQLITE_MIGRATION_REQUIRED` 时跳过 `migrate:sqlite`：

```bash
./sunabot.sh down

MIGRATION_RAW_BACKUP=/absolute/path/on/encrypted-off-host-storage/sunabot-before-migration
case "$MIGRATION_RAW_BACKUP/" in
  "$SUNABOT_WORKSPACE/"*) exit 1 ;;
esac
install -d -m 700 "$MIGRATION_RAW_BACKUP"
(
  cd "$SUNABOT_WORKSPACE"
  ARCHIVE_PATHS=()
  for entry in business runtime/napcat secrets cache config agents artifacts security napcat .env; do
    test ! -e "$entry" || ARCHIVE_PATHS+=("$entry")
  done
  test "${#ARCHIVE_PATHS[@]}" -gt 0
  tar -cpf "$MIGRATION_RAW_BACKUP/workspace-before-layout.tar" "${ARCHIVE_PATHS[@]}"
)
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$MIGRATION_RAW_BACKUP" && \
    sha256sum workspace-before-layout.tar > workspace-before-layout.tar.sha256 && \
    sha256sum -c workspace-before-layout.tar.sha256)
else
  (cd "$MIGRATION_RAW_BACKUP" && \
    shasum -a 256 workspace-before-layout.tar > workspace-before-layout.tar.sha256 && \
    shasum -a 256 -c workspace-before-layout.tar.sha256)
fi

# 仅在预检返回 WORKSPACE_LAYOUT_MIGRATION_REQUIRED 时执行
npm run workspace:migrate

npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced \
  --backup-root "$MIGRATION_RAW_BACKUP/pre-sqlite-recovery"
PRE_SQLITE_BACKUP="$(find "$MIGRATION_RAW_BACKUP/pre-sqlite-recovery" \
  -mindepth 1 -maxdepth 1 -type d ! -name '.partial-*' | sort | tail -n 1)"
test -n "$PRE_SQLITE_BACKUP"
npm run backup:verify -- --backup "$PRE_SQLITE_BACKUP"

# 仅在预检返回 SQLITE_MIGRATION_REQUIRED 时执行
npm run migrate:sqlite
npm run migrate:multi-agent -- --workspace "$SUNABOT_WORKSPACE"
```

每个适用命令都必须成功后才能继续。完整 `MIGRATION_RAW_BACKUP` 文件夹必须直接复制到访问受限的受控异机存储，并保持 `0700`；不创建加密包或等待口令，复制前后使用 SHA-256 与目标回读校验。原始归档保留被 `migrate:sqlite` 删除的 JSON/JSONL 与附件分块来源，恢复点保留布局迁移后的规范双库，两者缺一时停止。

## 执行迁移

停止统一运行入口并确认端口已经释放：

```bash
./sunabot.sh down
./sunabot.sh status
```

迁移器还会检查 PID 文件、配置中的 API 端口、固定 Core/OneBot/NapCat 端口、全部注册账号的 WebUI 端口，以及带当前 workspace 标签的全部活动容器；paused、restarting 等非停止状态都会阻断，Docker 状态无法读取时以 `RUNTIME_INSPECTION_FAILED` 关闭迁移。通过预检后执行：

```bash
npm run migrate:multi-agent -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --apply \
  --quiesced
```

执行过程依次完成：

1. 检查规范主库、队列库、配置、Plana workspace、环境覆盖与全部运行状态。
2. 校验 SQLite 完整性、外键和迁移目标冲突。
3. 在 `workspace/backups/sqlite-recovery/` 创建并复验 manifest v2 恢复点；标准旧单 Agent 工作区的范围为 Plana 双库。
4. 通过当前 `ApplicationDataStore` 执行向前 schema 迁移。
5. 登记 `plana` Agent 和 `primary` QQ 接入，创建 Plana `agent.json`。
6. 在生产初始化前显式补齐缺失的公共系统提示词；仅有旧 `conversation_reply.json` 时，用它补齐缺失的私聊与群聊回复提示词，`agent.json` 的 `prompts.overrideSystem` 默认为 `false`。
7. 将旧 `NAPCAT_ACCOUNT` 回填到 primary 注册记录和账号环境文件。
8. 将旧 NapCat 配置、QQ 登录态、插件、二维码和登录标记复制到 `accounts/primary/`。
9. 核对旧业务表和队列表记录数、NapCat 文件哈希、系统提示词哈希、SQLite 完整性与外键；保留差异还要复验当前目标哈希未变化。
10. 在恢复点目录写入 `single-agent-to-multi-agent.json`。
11. 对完整注册集合执行写标记前校验，再原子写入 `business/migrations/multi-agent-v1.json`，绑定恢复点 ID、恢复 manifest、迁移报告、源状态、目标 workspace 与注册信息，并复验完成状态。

成功结果会给出两个关键路径：

```json
{
  "mode": "applied",
  "recoveryPoint": "/.../sqlite-recovery-...",
  "reportPath": "/.../sqlite-recovery-.../single-agent-to-multi-agent.json"
}
```

保存这两个路径，直到重启验收完成。

迁移报告的四类证据必须分别复验：

| 字段 | 验收 |
| --- | --- |
| `copiedRuntimeEntries` | 只包含本次确实写入的 NapCat 条目，目标哈希与来源一致 |
| `preservedRuntimeDivergences` | 包含旧源与当前目标两侧类型及 SHA-256，apply 后目标哈希保持不变 |
| `copiedSystemPrompts` | 只包含本次确实写入的公共提示词，目标哈希与来源一致 |
| `preservedSystemPromptDivergences` | 包含旧源与当前公共版本两侧 SHA-256，apply 后当前版本保持不变 |

迁移成功后仍保持服务停止，再创建一份当前多 Agent 结构的恢复点：

```bash
npm run backup:create -- \
  --workspace "$SUNABOT_WORKSPACE" \
  --quiesced
```

从 JSON 输出中记录新的 `backupDirectory`，再执行：

```bash
npm run backup:verify -- --backup "/absolute/path/from/backupDirectory"
```

新 manifest v2 必须以 Plana 注册表和 `business/agents/*/data` 扫描结果的一致集合为范围。本次标准迁移完成后至少包含 `agent:plana:application` 和 `agent:plana:session_queue`。

## 重启与验收

```bash
./sunabot.sh up
./sunabot.sh doctor
./sunabot.sh status
curl -fsS http://127.0.0.1:8787/api/auth/session >/dev/null
```

管理台验收内容：

- Agent 列表存在 Plana，原人格、记忆、会话、图片和 Bot 行为可读。
- “系统提示词”显示迁移前的完整最终提示词；Plana 的“覆盖系统提示词”保持关闭，运行时使用公共版本。
- Plana 下存在“主账号”，账号 ID 为 `primary`，WebUI 端口为 `6099`。
- 主账号可以退出 QQ 登录，管理台没有移除入口，直接调用移除 API 返回 `PRIMARY_ACCOUNT_REQUIRED`；其他离线账号仍可移除。
- 原 QQ 登录态可继续使用；登录态失效时只对 `primary` 重新扫码。
- 从原 QQ 发一条私聊和一条群消息，回复由同一 QQ 发出。
- 原 Token 总量与迁移前一致；Plana 统计等于当前全局总量。
- 新建测试 Agent 后默认继承公共系统提示词，其会话、记忆、人格提示词和 Token 统计不出现在 Plana 中。
- 在测试 Agent 中开启“覆盖系统提示词”，修改一项并验证只影响该 Agent；关闭覆盖后恢复公共版本。

恢复点仍需单独复验：

```bash
npm run backup:verify -- --backup "/absolute/path/from/recoveryPoint"
```

## 失败处理

迁移器在恢复点创建后失败时，错误 JSON 的 `details.recoveryPoint` 指向可恢复的双库备份。旧 NapCat 根目录仍然保留。目标目录中的复制文件属于可重复执行的兼容副本，修复冲突后可以重新运行 dry-run 和 apply。

首次安装为 marker、主库、queue、manifest、注册行和账号目录写入带 HMAC 的 durable journal。任一边界中断后，再次执行 `./sunabot.sh up` 会按 journal 幂等继续；执行 `./sunabot.sh rollback-first-run` 会逐项回滚已知产物并保留未知文件。完成前必须通过主库 schema 9、queue schema 4、关键表列、约束、外键、索引、完整注册关系和父链路径校验；损坏库、旧 schema、伪造最小表或用户符号链接都会失败关闭，不能通过补空库绕过门禁。

以下情况禁止启动服务：

- `DATABASE_COUNT_MISMATCH`
- `DATABASE_INTEGRITY_FAILED`
- `DATABASE_FOREIGN_KEY_FAILED`
- `RUNTIME_COPY_VERIFICATION_FAILED`
- `SYSTEM_PROMPT_TARGET_CONFLICT`
- `MIGRATION_INCOMPLETE`
- `AGENT_REGISTRY_INVALID`
- `AGENT_DATABASE_PAIR_MISSING`
- `AGENT_DATABASE_PAIR_INCOMPLETE`
- `AGENT_DATABASE_ORPHAN`
- `AGENT_DATABASE_PATH_INVALID`
- `MULTI_AGENT_MIGRATION_MARKER_INVALID`
- `MULTI_AGENT_MIGRATION_STATE_INVALID`
- `RUNTIME_INSPECTION_FAILED`
- 恢复点复验失败

## 回滚到旧单 Agent 版本

回滚需要同时恢复旧代码 revision 和迁移前同一恢复点内的 Plana 业务库与队列库。仅恢复其中一个数据库会破坏会话与 outbox 的一致性。如果迁移前 manifest v2 中还包含其他 Agent，旧单 Agent 代码无法消费该范围，需要停止自动回滚并单独制定数据与代码恢复方案。

保持服务停止，设置成功输出中的恢复点：

```bash
export BACKUP=/absolute/path/to/sqlite-recovery-...
export ROLLBACK_ROOT="$SUNABOT_WORKSPACE/backups/multi-agent-rollback-$(date +%Y%m%d-%H%M%S)"
export RESTORED_WORKSPACE="$ROLLBACK_ROOT/restored-workspace"
mkdir -p "$ROLLBACK_ROOT/live-databases"
npm run backup:verify -- --backup "$BACKUP"
npm run backup:restore -- --backup "$BACKUP" --target-workspace "$RESTORED_WORKSPACE"
```

把当前双库及可选 WAL/SHM 文件移动到独立现场目录：

```bash
for NAME in \
  sunabot.sqlite sunabot.sqlite-wal sunabot.sqlite-shm \
  session-queue.sqlite session-queue.sqlite-wal session-queue.sqlite-shm
do
  SOURCE="$SUNABOT_WORKSPACE/business/data/$NAME"
  if [ -e "$SOURCE" ]; then
    mv "$SOURCE" "$ROLLBACK_ROOT/live-databases/$NAME"
  fi
done
```

放回恢复后的双库：

```bash
cp "$RESTORED_WORKSPACE/business/data/sunabot.sqlite" \
  "$SUNABOT_WORKSPACE/business/data/sunabot.sqlite"
cp "$RESTORED_WORKSPACE/business/data/session-queue.sqlite" \
  "$SUNABOT_WORKSPACE/business/data/session-queue.sqlite"

MARKER="$SUNABOT_WORKSPACE/business/migrations/multi-agent-v1.json"
if [ -f "$MARKER" ]; then
  mv "$MARKER" "$ROLLBACK_ROOT/multi-agent-v1.json"
fi
```

移出的完成标记与现场数据库一同保留，避免恢复后的旧数据库被当前 launcher 识别为已完成迁移。切换到迁移前记录的代码 revision，再使用该版本原有启动方式验证。`business/agents/plana/agent.json`、`business/prompts/` 与 `runtime/napcat/accounts/primary/` 可以保留为兼容副本，旧单 Agent 版本继续读取 Plana 工作区中的原提示词、原配置、原主库和原 NapCat 根目录。完成旧版本消息回环检查前，不清理迁移报告、恢复点或现场数据库。
