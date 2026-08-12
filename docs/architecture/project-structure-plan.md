# sunabot 项目结构与运行架构

日期：2026-08-12
状态：v0.3.0 当前架构
唯一业务规范入口：`docs/specs/index.md`
执行任务：`docs/todo.md`

## 1. 架构目标

1. macOS、WSL2 和 Linux 都通过根目录 `./sunabot.sh` 操作一个 Native Core。
2. 一个 Core 运行多个隔离 Agent，一个 Agent 可绑定多个 QQ 账号。
3. 每个 QQ 账号使用独立 NapCat Docker 容器、登录态目录和 WebUI 端口；NapCat 是唯一 Docker 例外。
4. Bash、MCP、Skill Script、Codex 与 WebFetch 都在 Native 运行边界内执行。Linux/WSL launcher 固定并验证一个绝对 Bubblewrap 入口，再通过 `SUNABOT_BWRAP_EXECUTABLE` 注入 Native Bash、stdio MCP、Skill Script 与 WebFetch Renderer；发行进程缺少该注入时失败，不能回落宿主 `/usr/bin/bwrap`。源码形态明确使用系统路径，macOS 按能力合同开放或报告不可用。
5. 每个 Agent 只有一个 canonical `workbench/`，业务资源和执行产物不再按运行后端拆分。
6. Linux amd64/arm64 发行包自包含 Node、生产依赖、Codex、Lightpanda，以及 Bubblewrap 的 ELF loader 与完整动态库闭包；安装完成后的启动过程零下载。
7. OneBot、媒体和文件使用明确的跨组件契约，不依赖 Core 与 NapCat 共享绝对路径。
8. 升级要求停服、全 Agent 恢复点、迁移报告、重启验收和可演练回滚，旧新运行时不得同时写入同一 workspace。

Windows 主机通过 WSL2 使用 Linux 发行包；当前不提供 Windows Native。发行平台固定为 `linux/amd64` 与 `linux/arm64`，两者必须由同一 runtime contract 和 component lock 生成。

## 2. 不可破坏的边界

- 会话、消息、记忆、调度队列、请求日志和历史索引等增长型业务数据只写入 SQLite。
- SQLite schema 只允许向前迁移，升级不依赖删库重建。
- `workspace/` 不进入 Git；凭据、QQ 登录态、数据库、日志、缓存、生成图片和备份不得进入源码包或 release asset。
- 管理台只监听宿主回环 `127.0.0.1:8787`。
- OneBot v11 使用专用 `8788` listener 和强制 access token，只接受同机 NapCat 容器通过宿主网关连接。
- 每个 NapCat WebUI 使用注册表分配的独立回环端口，首个账号默认为 `6099`。
- NapCat 不进入 Core 进程、Native 工具沙箱或发行归档；公开再分发授权尚未确认，安装期只按 component lock 准备上游摘要固定的镜像。
- 启动阶段固定使用 Docker `--pull never`；锁定 NapCat 镜像缺失时明确失败并要求重新执行安装程序。
- 跨组件媒体默认使用 OneBot `base64://`；共享卷或相同挂载点不能代替传输契约。
- 平台差异只存在于 `apps/*` 组合根、明确的 platform adapter、`tooling/runtime/` 和 `deploy/`。

## 3. 代码结构

```text
sunabot/
├── install.sh                          # GitHub Release Bash 安装程序
├── sunabot.sh                          # 唯一人工运行入口
├── apps/
│   ├── api/                            # Native Core composition root、HTTP 与 OneBot listeners
│   ├── admin-web/                      # Vue 管理台
│   └── webfetch-renderer/              # Native Lightpanda renderer 与回环代理
├── services/
│   ├── agents/                         # Agent 注册、运行时和 canonical Workbench
│   ├── agent/                          # 人格与最终提示词
│   ├── messaging/                      # 命令、hook 与消息用例
│   ├── conversations/                  # 会话目录与显示名
│   ├── sessions/                       # 事件、turn、deferred job 与 outbox
│   ├── orchestration/                  # 回复门控、群聊编排和广播风暴
│   ├── memory/                         # 工作记忆、长期记忆、用户画像与调度
│   ├── media/                          # 附件与文档内容
│   ├── tools/                          # Native Agent 工具目录与执行
│   ├── webfetch/                       # 网页抓取、分块、筛选和预算
│   └── delivery/                       # 出站媒体边界
├── adapters/
│   ├── onebot/                         # OneBot 连接、事件、action 和 QQ 媒体
│   ├── model/                          # Provider 协议、模型发现与工具执行
│   ├── webfetch/                       # 静态抓取、Defuddle 与 renderer client
│   ├── codex/                          # Native Codex CLI adapter
│   ├── filesystem/                     # Native Skill Script adapter
│   └── sqlite/                         # schema、业务存储、统计和管理会话
├── packages/
│   ├── contracts/                      # 跨模块版本契约
│   ├── platform/                       # 路径、发行目录和 Agent 资源布局
│   └── testkit/
├── src/
│   ├── runtime.ts                      # 运行时组合层
│   ├── runtime/                        # intake、reply 与 delivery 用例分片
│   └── admin/                          # 管理配置、灵魂文件与 Agent 文件服务
├── components/
│   ├── component.lock.json             # Node/Codex/Lightpanda/Bubblewrap/NapCat 锁
│   └── napcat/                         # 外部 NapCat 集成与来源说明
├── deploy/
│   ├── runtime-contract.json           # v3 Native 运行合同
│   ├── native/                         # Native Core 内部入口
│   └── napcat/                         # 每账号 NapCat Compose 模板
├── tooling/
│   ├── runtime/                        # launcher、doctor、contract 与 release
│   ├── agents/                         # 灵魂文件 CLI
│   ├── migrations/                     # SQLite、Workbench 和多 Agent 迁移
│   └── workspace/                      # 初始化、恢复点和演练
├── tests/
└── workspace/                          # 终端私有，不进入 Git
```

`src/runtime.ts` 只组合运行用例。Agent 注册表依赖 repository port，由 API composition root 注入 SQLite adapter。公共管理配置、Provider 模型和消息类型位于 `packages/contracts/`；项目与 workspace 路径位于 `packages/platform/`。services、adapters 与 platform 不反向导入 `src/`。

## 4. 运行拓扑

```text
宿主机 ./sunabot.sh
├── Sunabot Native Core × 1
│   ├── 127.0.0.1:8787 管理 API 与管理台
│   ├── :8788 OneBot v11 反向 WebSocket
│   ├── AgentRuntimeManager
│   │   └── 每个启用 Agent 一套 Runtime / SessionCoordinator
│   ├── Native Bash / MCP / Skill / Codex
│   └── Linux/WSL Lightpanda renderer（Bubblewrap）
└── NapCat Docker × 已启用 QQ 账号
    ├── 每账号独立 Compose project 与容器
    ├── 每账号独立 WebUI 端口
    └── 每账号独立配置、QQ 登录态和运行标记
```

Launcher 从 Plana 注册主库读取已启用账号，为每个账号设置稳定 `accountId`、QQ 号和 WebUI 端口，再以 `deploy/napcat/compose.yml` 和独立 Compose project 启动容器。容器标签保留 workspace 身份、组件和 `account-id`，用于启停、调和与冲突检测。Core 不挂载 Docker socket；账号生命周期由宿主 account runtime daemon 执行。

### 4.1 OneBot

NapCat 使用 launcher 配置的 `ws://<host-gateway>:8788/onebot/v11/ws?account_id=<accountId>` 连接 Native Core。`account_id` 是 QQ 账号到 Agent 唯一归属的路由键，不能由显示名、QQ 号或容器名推断。listener 不发布到局域网或公网。

### 4.2 媒体与文件

`MediaAssetRef` 表达文件身份、类型、大小和内容来源，不向业务层暴露组件本地绝对路径。出站图片经边界校验后编码为 `base64://`。超过内联预算的大文件需要另行定义鉴权、限流、过期和内容长度合同；NapCat 容器内路径不能进入 Core 业务层。

## 5. Workspace 与所有权

```text
workspace/
├── business/
│   ├── config/sunabot.json
│   ├── prompts/                        # 公共系统提示词
│   ├── data/
│   │   ├── sunabot.sqlite             # Plana 业务库 + Agent/QQ 注册表
│   │   └── session-queue.sqlite
│   ├── agents/
│   │   ├── plana/
│   │   └── <agentId>/
│   │       ├── agent.json
│   │       ├── AGENTS.md / SOUL.md / PREFERENCE.md
│   │       ├── DIALOGUE_STYLE_EXAMPLES.md / USER.md / RELATION.md
│   │       ├── workbench/
│   │       │   ├── index.md
│   │       │   ├── selfie/references.jsonl
│   │       │   ├── emoji/emojis.jsonl
│   │       │   ├── skills/index.json
│   │       │   └── knowledge/index.json
│   │       ├── extensions/mcp/servers.json
│   │       └── data/{sunabot.sqlite,session-queue.sqlite}
│   └── media/
├── runtime/
│   ├── napcat/accounts/<accountId>/
│   │   ├── config-full/
│   │   ├── qq/
│   │   ├── plugins/
│   │   └── 二维码与运行标记
│   ├── logs/
│   └── tmp/
├── cache/
├── secrets/
│   └── admin-credentials.json
└── backups/
```

| 所有者 | 可读写范围 |
| --- | --- |
| Native Core | `business/`、`cache/`、`secrets/`、Core 日志与临时目录 |
| 某 Agent 运行时 | 该 Agent 的人格、双库、媒体与 canonical `workbench/` |
| 某 NapCat 容器 | `runtime/napcat/accounts/<accountId>/` |
| Launcher | 运行配置、账号 NapCat 配置、状态和组件生命周期 |

Plana 保留 `business/data/` 的历史稳定路径，同时承担 Agent 和 QQ 注册主库；其他 Agent 的业务数据位于自己的 `data/` 双库。

### 5.1 单一 Workbench

Bot 可取用的自拍、表情、Skill 和知识资料都位于当前 Agent 的 `workbench/`，对应权威入口为 `selfie/references.jsonl`、`emoji/emojis.jsonl`、`skills/index.json` 与 `knowledge/index.json`。Native Bash 的 cwd、Codex 输入输出、聊天媒体导出和管理台资源操作都解析同一根目录。

v0.2 的 `docker-workbench/` 只在 0.2→0.3 停服迁移中作为源目录出现。迁移器在任何写入前创建恢复点，发现资源或 SQLite 冲突时保持零修改；成功后归档旧目录并记录 manifest。v0.3 运行时代码、管理台和新安装不创建或读取旧目录。

## 6. Native 运行合同

`deploy/runtime-contract.json` schema v3 定义 Node `24.18.0`、端口、Native 工具、组件锁、健康检查、发行平台和 NapCat 摘要。根入口支持：

```text
up | start | down | restart | status | logs | doctor | bootstrap
```

Core 形态固定为 Native；旧 `SUNABOT_CORE_MODE=docker` 与 Core Compose 路径不再属于 v0.3.0 合同。`up`、`start` 和 `restart` 使用同一套清空后启动流程。

首次交互式 `up` 在 Core 和 NapCat 启动前进入 CLI Landing，要求设置管理员名称与至少 12 字符密码，并将 scrypt 派生结果写入 `workspace/secrets/admin-credentials.json`。非交互启动且凭据缺失时明确失败。

当前启动顺序为：发行完整性与依赖检查 → 锁定 NapCat 镜像存在性 → workspace 与迁移门禁 → Landing/运行密钥 → 清理同 workspace 的旧进程和账号容器 → Native Core 与能力探针 → 逐账号 NapCat → account runtime daemon → 稳定窗口与 readiness。普通启动不执行 npm install、浏览器下载、容器构建或镜像拉取。

## 7. 发行边界

GitHub Release 为 Linux amd64 与 arm64 各提供归档和 SHA-256 文件。归档包含：

- `sunabot.sh`、`dist/`、管理台产物、production `node_modules`；
- Node `24.18.0`；
- Codex CLI `0.139.0`；
- Lightpanda `0.3.3`、对应源码与许可；
- Bubblewrap、包内 ELF loader、完整动态库闭包、对应 Debian 源码与许可；
- launcher、迁移器、runtime contract、component lock、NapCat Compose 模板和当前文档。

安装脚本校验架构、归档 SHA-256 和 release manifest，在版本目录内原子安装，然后检查或拉取 component lock 中摘要固定的 NapCat 上游镜像。NapCat/QQ 本体不随 release 重新分发。安装结束后运行离线 `bootstrap` 校验随包依赖，并原子切换 `current` 链接。

## 8. 灵魂文件

当前 Agent 的六个人格文件通过 `.sunabot-soul.json` 导出。WebUI 和 `tooling/agents/soul.mjs` CLI 共用本地管理员 API：导出、预览与导入都绑定明确 `agentId`；导入在预览后选择冲突策略并事务提交，任一失败保持目标文件原状。包不包含 Provider key、管理员凭据、QQ 登录态、SQLite、记忆、Workbench 文件或运行缓存。

## 9. 迁移与恢复

迁移顺序固定为：

1. 识别真实 workspace、代码 revision、旧进程/容器、挂载和端口。
2. 停止旧 Core 与全部 NapCat，禁用旧自动重启单元并确认无写入。
3. 在任何写入前创建完整原始布局归档和全 Agent SQLite 恢复点并复验。
4. 按旧版本逐级执行 schema、多 Agent 与 0.2→0.3 单一 Workbench 迁移。
5. 验证迁移报告、文件摘要、SQLite `integrity_check`、外键、注册表和账号目录。
6. 通过 v0.3 launcher 启动，验收双 QQ 定向收发、重启和冷启动恢复。

迁移检测到未知文件、资源冲突、SQLite 冲突、符号链接、路径越界、缺库或注册漂移时必须停止，并保持资源与数据库零修改。恢复点和旧 Workbench 归档在稳定验收完成前保留。重复执行只允许返回 `already-migrated` 或验证现有结果，不能再次复制、覆盖或删除数据。

## 10. 完成标准

| 目标 | 证明材料 |
| --- | --- |
| 单入口 | 支持平台只使用 `./sunabot.sh`，依赖缺失时返回明确状态 |
| Native Core 唯一 | 同一 workspace 只有一个 Native Core，无 Core 容器和分裂写入 |
| Docker 边界 | 运行中的业务容器只有每账号 NapCat |
| 单一 Workbench | 资源和工具只访问 canonical `workbench/`；旧目录仅见于迁移归档 |
| 账号隔离 | 每个启用 QQ 拥有独立容器、账号目录、标签和 WebUI 端口 |
| Agent 数据隔离 | 各 Agent 双库、人格、Workbench 与统计按规范分开 |
| OneBot 路由 | 专用 8788、token 强制、`account_id` 唯一归属、无公网发布 |
| Native 工具 | Bash/MCP/Skill/Codex/WebFetch 无额外容器，Linux/WSL Bubblewrap 真实 namespace probe 失败即停止 |
| 自包含发行 | amd64/arm64 归档内 Bubblewrap 的全部 ELF 依赖解析到包内目录；安装后启动零下载 |
| 首次使用 | CLI Landing 完成管理员名称与密码设置后才启动服务 |
| 灵魂往返 | WebUI 与 CLI 导出、预览、冲突导入及再次导出一致 |
| 全 Agent 可恢复 | manifest、SHA-256、SQLite 完整性、队列不变量和隔离恢复演练通过 |
