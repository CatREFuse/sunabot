# 老版本升级到当前版本

适用范围：现有实例版本为 `0.1.0`、`0.1.1`、`0.1.2`、`0.1.3`、`0.1.4` 或 `0.2.0`，目标是升级到 `0.3.0`，并保留 workspace、全部 Agent 数据、QQ 登录态、表情、自拍参考图、知识库和提示词。

低于 `0.1.0`、版本无法确认、workspace 来源不明或已经同时被多个实例写入时，停止升级并先完成数据与运行时审计。旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service 仍在运行的实例，必须先执行 [旧单容器切换](./one-container-to-split-runtime.md)。

## 升级原则

- 全程由拥有仓库和 workspace 的同一个非 root 用户执行。
- 同一 workspace 同时只能有一个 Core 和一组所属 NapCat 写入。
- 各版本必须逐级升级，禁止跳过中间版本。
- 每个 `upgrade:<version>` 命令必须来自目标版本的完整发布包或批准 revision。脚本会检查 `package.json`、lockfile、runtime contract、发行目录和 Docker 版本面，代码版本不一致时返回 `TARGET_RELEASE_MISMATCH`。
- 不凭版本号猜测 Git tag。没有对应 tag 时使用经过确认的发布归档、发行 manifest 绑定的 source commit，或维护者明确批准的 revision。
- 每一级 `apply` 返回的恢复点、迁移报告、代码 revision、`status` 和 `doctor` 结果都要保存。
- 禁止使用 `git reset --hard`、`git clean`、删除数据库或创建第二套空 workspace 处理迁移失败。
- `connected=unknown` 只表示尚未取得 QQ 连接证据，不能作为真实收发成功的验收结果。

## 升级路径

| 当前版本 | 执行顺序 |
| --- | --- |
| `0.1.0` / `0.1.1` | `0.1.2` → `0.1.3` → `0.1.4` → `0.2.0` → `0.3.0` |
| `0.1.2` | `0.1.3` → `0.1.4` → `0.2.0` → `0.3.0` |
| `0.1.3` | `0.1.4` → `0.2.0` → `0.3.0` |
| `0.1.4` | `0.2.0` → `0.3.0` |
| `0.2.0` | `0.3.0` |

每一行都从当前实际版本开始执行。已经完成且有恢复点、迁移报告、目标版本与运行验证证据的阶段无需重复。

## 1. 记录升级前现场

在当前生产实例目录记录以下输出。命令不存在或失败时保留原始错误，不用其他命令修改现场。

```bash
pwd -P
git status --short
git rev-parse HEAD
node -p "require('./package.json').version"
./sunabot.sh status
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

同时确认并记录：

- workspace 的绝对路径；
- Core 当前是 Native 还是 Docker；
- 全部 Agent、QQ 账号和 NapCat WebUI 端口；
- 旧容器、Compose project 和自动重启策略；
- workspace 所有者与执行升级的用户；
- 可用磁盘空间和异机备份位置；
- 当前管理台、Provider、文本消息与图片消息的可用状态。

默认 workspace 是仓库根的 `workspace/`。自定义 workspace 后续所有命令都必须使用同一个绝对路径。

```bash
export SUNABOT_WORKSPACE=/absolute/path/to/workspace
test -d "$SUNABOT_WORKSPACE"
```

### 旧布局门禁

版本链开始前检查旧运行结构与数据布局。命中任一项时先完成对应迁移，再重新记录版本和 workspace 状态：

| 现场状态 | 必须执行 |
| --- | --- |
| 存在旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service | 按 [旧单容器切换](./one-container-to-split-runtime.md) 完成停服、全量备份、运行时拆分和验收 |
| 仍使用旧 `config/agents/artifacts/security/napcat/.env` 目录 | 在拥有该迁移器的批准代码中停服执行 `npm run workspace:migrate` |
| 会话、记忆、调度、请求日志或图片历史仍使用旧 JSON/JSONL | 停服执行 `npm run migrate:sqlite`，核对导入身份、记录数、恢复点和旧源退役 |
| 缺少多 Agent 完成标记，或仍是单 Agent 数据结构 | 按 [单 Agent 到多 Agent 迁移](./single-agent-to-multi-agent.md) 执行只读预检、停服 apply、恢复点和完整集合校验 |

旧单容器切换可能使用已经包含后续能力的批准发布包。完成后重新按实际代码 revision、workspace marker 和迁移报告选择升级起点，已经由该切换明确完成的阶段不重复执行。

## 2. 准备每一级目标代码

为下一目标版本准备独立、干净的发布目录。目标代码必须包含对应升级脚本、`package.json`、lockfile、runtime contract、Docker 文件和迁移文档。

进入目标发布目录后先核对版本，再执行只读 `plan`：

```bash
git status --short
git rev-parse HEAD
node -p "require('./package.json').version"
```

源码部署按该版本锁文件安装依赖；Linux 正式发行包使用包内预构建产物和 manifest 校验流程。不要把生产 workspace 复制进代码仓库，也不要让两个发布目录同时启动同一 workspace。

## 3. 按版本逐级执行

### 0.1.0 / 0.1.1 → 0.1.2

在完整 `0.1.2` 代码中执行：

```bash
npm run upgrade:0.1.2 -- plan --workspace "$SUNABOT_WORKSPACE"
npm run upgrade:0.1.2 -- apply --workspace "$SUNABOT_WORKSPACE"
```

该阶段完成自拍 `references.json` 到 `references.jsonl` 的转换，迁移表情 JSONL，把旧自拍、表情、Skills 和知识库移动到 Native workbench，并建立独立 Docker workbench 与 Native 只读投影。完整边界和回滚见 [0.1.0 / 0.1.1 升级到 0.1.2](./upgrade-0.1.0-to-0.1.2.md)。

### 0.1.2 → 0.1.3

在完整 `0.1.3` 代码中执行：

```bash
npm run upgrade:0.1.3 -- plan --workspace "$SUNABOT_WORKSPACE"
npm run upgrade:0.1.3 -- apply --workspace "$SUNABOT_WORKSPACE"
```

该阶段创建全 Agent SQLite 恢复点，并在启动时保留式迁移聊天媒体提示词。完整边界和回滚见 [0.1.2 升级到 0.1.3](./upgrade-0.1.2-to-0.1.3.md)。

### 0.1.3 → 0.1.4

在完整 `0.1.4` 代码中执行：

```bash
npm run upgrade:0.1.4 -- plan --workspace "$SUNABOT_WORKSPACE"
npm run upgrade:0.1.4 -- apply --workspace "$SUNABOT_WORKSPACE"
```

该阶段创建全 Agent SQLite 恢复点，并启用异步图片参考归档与群聊上下文隔离。完整边界和回滚见 [0.1.3 升级到 0.1.4](./upgrade-0.1.3-to-0.1.4.md)。

### 0.1.4 → 0.2.0

在完整 `0.2.0` 代码中执行：

```bash
npm run upgrade:0.2.0 -- plan --workspace "$SUNABOT_WORKSPACE"
npm run upgrade:0.2.0 -- apply --workspace "$SUNABOT_WORKSPACE"
```

该阶段创建全 Agent SQLite 恢复点，并按平台启用受监管的动态 WebFetch Renderer。完整边界和回滚见 [0.1.4 升级到 0.2.0](./upgrade-0.1.4-to-0.2.0.md)。

### 0.2.0 → 0.3.0

在完整 `0.3.0` 代码包中执行逐文件只读预检：

```bash
npm run upgrade:0.3.0 -- plan --workspace "$SUNABOT_WORKSPACE"
```

plan 枚举全部 Agent 的 canonical `workbench/` 与旧 `docker-workbench/`。目标缺失的普通文件列为 copy，字节相同的普通文件列为 identical；内容差异、类型差异、链接、特殊文件、硬链接或非空旧 `native-workbench/` 投影列为冲突。冲突报告写入 `workspace/backups/upgrade-0.3.0/conflicts/`，并明确资源目录与 SQLite 均未修改。

确认 plan 无冲突后停止服务并执行 apply：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh down
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
npm run upgrade:0.3.0 -- apply --quiesced --workspace "$SUNABOT_WORKSPACE"
```

apply 创建覆盖全部 Agent 业务库、queue 数据库与迁移前两套资源树的恢复点，只复制目标缺失的文件并核对摘要，字节相同的目标保持原样；固定入口全部验证通过且 SQLite 前后摘要一致后，旧 `docker-workbench/` 整棵归档到恢复点。复制、入口校验或归档失败会自动恢复迁移前资源树，服务保持停止。

使用 apply 返回的恢复点执行验证：

```bash
npm run upgrade:0.3.0 -- verify \
  --workspace "$SUNABOT_WORKSPACE" \
  --recovery /absolute/path/to/recovery-point
```

完整边界和回滚见 [0.2.0 升级到 0.3.0](./upgrade-0.2.0-to-0.3.0.md)。

验证通过后启动：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh up
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

首次启动会执行当前 schema 的前向 SQLite 迁移、保留式提示词迁移和预装 `workbench-config` Skill 升级。任一启动迁移失败时停止操作，保留现场与本阶段恢复点。

## 4. 单一 Workbench 资源验收

每个 Agent 应具有以下布局：

```text
workspace/business/agents/<agentId>/
└── workbench/
    ├── index.md
    ├── selfie/references.jsonl
    ├── emoji/emojis.jsonl
    ├── skills/index.json
    └── knowledge/index.json
```

生产 Agent 根下不得继续存在 `docker-workbench/`；旧根只应位于该次恢复点的 `archived/agents/<agentId>/docker-workbench/`。表情、自拍参考图、知识资料、任务文件与 Skill 源包都从 canonical `workbench/` 读取；管理 API 与内容 URL 只按 `agentId` 定位，不包含 `workbench=native|docker|all`、来源字段或 `docker-workbench` 路径段。

在管理台逐个切换 Agent 并检查：

1. 表情页只显示一套当前 Agent 记录；
2. 图像页自拍参考区只显示一套素材；
3. 知识库列表与搜索结果不显示 Workbench 来源；
4. 新增、修改和删除都落在 canonical `workbench/`；
5. 切换 Agent 后列表、搜索结果和弹层不保留前一个 Agent 的内容；
6. 重启后相同资源仍可读取，且旧根没有重新创建。

生产资源不适合直接修改时，在隔离 workspace 完成第 4 项，再对生产执行只读列表与检索验收。

## 5. 服务与真实消息验收

基础健康检查：

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:8787/api/auth/session >/dev/null

test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:8788/healthz)" = "204"

SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

`status` 至少应显示 Core `live`、`ready`、Capabilities `ready`，每个启用账号均为 `desired=running` 与 `observed=running`。随后逐 Agent 完成真实 QQ 验收：

- 私聊与群聊文本从原账号定向回复；
- @、引用回复和 action 回包正常；
- Bot 可以发送 canonical Workbench 中的表情；
- 自拍可以选择唯一清单中的参考图并直接回传；
- `knowledge_search` 可以命中 canonical 确定性资料；
- 重启后 Core、NapCat、SQLite、QQ 登录态和单一 Workbench 资源恢复。

真实 QQ 验收记录账号、会话类型、时间、输入、输出和消息 ID，不记录 token、凭据、绝对路径或消息正文之外的私密数据。

## 6. 回滚

回滚前使用当前发布目录的 `./sunabot.sh down` 停止 Core 与全部 NapCat，并确认没有第二个实例写入 workspace。

版本升级阶段失败时：

1. 保留失败现场；
2. 使用该阶段 `apply` 返回的全 Agent SQLite 恢复点；
3. 切回该阶段的来源版本代码；
4. 按对应版本迁移文档恢复提示词或资源备份；
5. 使用来源版本的 `./sunabot.sh up`、`status`、`doctor` 验证。

单一 Workbench 迁移回滚只在资源从迁移后没有变化时执行：

```bash
npm run upgrade:0.3.0 -- rollback --quiesced \
  --workspace "$SUNABOT_WORKSPACE" \
  --recovery /absolute/path/to/recovery-point
```

当前 revision 已经写入新数据库内容或产生新 outbox 后，使用完整恢复点恢复全部 Agent 的业务库与 queue，禁止只复制单个 SQLite 文件。恢复流程见 [全 Agent SQLite 备份、恢复与故障门禁](../operations/sqlite-backup-recovery.md)。

旧容器、旧代码目录、迁移前 workspace 归档、各阶段恢复点和迁移报告至少保留到当前版本稳定运行 24 小时并完成一次冷启动。确认数据、账号、资源和真实消息验收全部通过后，再按保留策略处理旧恢复材料。

## 7. 常见阻断

| 状态 | 处理 |
| --- | --- |
| `TARGET_RELEASE_MISMATCH` | 当前代码不属于该目标版本；换用完整目标发布包或批准 revision，禁止修改版本文件绕过检查 |
| `serviceMayBeStopped=true` | 服务可能保持停止；检查该阶段输出和恢复点，不直接启动下一版本 |
| 发现旧单容器 | 执行 `one-container-to-split-runtime.md`，保留旧容器作为回滚载体 |
| `upgrade:0.3.0 plan` 报告冲突 | 保持停服并人工核对两侧字节；不得选择一侧覆盖或跳过冲突 |
| `upgrade:0.3.0 verify` 失败 | 保持停服，按恢复点报告处理布局、归档、入口或 drift；不手工复制未知资源 |
| `doctor` 中 Provider 或 Renderer 失败 | 修复当前依赖或配置后重新执行 doctor，不进入真实 QQ 验收 |
| NapCat `connected=unknown` | 继续做账号登录和真实消息验收，状态本身不证明成功或失败 |
| 资源只在一侧可见 | 核对该侧固定入口、清单、权限与管理 API 来源，不把内容复制到另一侧掩盖问题 |

## 8. 完成记录

升级记录至少包含：

- 起始版本、每一级目标版本和对应 Git revision 或发行 manifest；
- 唯一 workspace 绝对路径和执行用户；
- 各阶段 `plan`、`apply`、恢复点与迁移报告；
- `upgrade:0.3.0 plan`、`apply` 与 `verify` 输出；
- 最终 `status`、`doctor`、管理 API 与 OneBot health 状态；
- 全部 Agent 的表情、自拍参考图与知识库 Native/Docker 可见性；
- 真实 QQ 私聊、群聊、图片、表情、知识检索与重启恢复结果；
- 未完成项，例如 `connected=unknown` 或尚未执行的冷启动验收。
