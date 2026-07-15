# sunabot 项目结构与运行架构

日期：2026-07-14
状态：当前多 Agent、多 QQ 架构与后续收口计划
唯一业务规范：`docs/specs/current-system-spec.md`
执行任务：`docs/todo.md`

## 1. 架构目标

1. macOS、WSL2 和 Linux 都使用根目录 `./sunabot.sh` 启停同一套业务系统。
2. Sunabot Core 保持模块化单体；一个 Core 运行多个 Agent，一个 Agent 可绑定多个 QQ 账号。
3. 每个 QQ 账号使用独立 NapCat Docker 容器、登录态目录和 WebUI 端口。
4. Core 可以 Native 或 Docker 运行，运行形态不改变 Agent 业务语义、SQLite schema 和 workspace 布局。
5. OneBot、媒体与文件通过明确契约跨组件边界，不依赖 Core 与 NapCat 共享绝对路径。
6. 升级要求停服、全 Agent 恢复点、迁移报告、重启验收和可演练回滚，旧新运行时不得同时写入同一 workspace。

Windows 主机通过 WSL2 运行，当前不承诺 Windows Native。`deploy/runtime-contract.json` 当前固定 `linux/amd64`，其他架构只能在组件锁、镜像和跨平台验证同步通过后增加。

## 2. 不可破坏的边界

- 会话、消息、记忆、调度队列、请求日志和历史索引等增长型业务数据只写入 SQLite。
- SQLite schema 只允许向前迁移，升级不依赖删库重建。
- `workspace/` 整体不进入 Git；凭据、QQ 登录态、数据库、日志、缓存、生成图片和备份不得进入源码包。
- 管理台只发布到宿主回环 `127.0.0.1:8787`。
- OneBot v11 使用专用 `8788` listener 和强制 access token，只允许 Compose 私有网络或同机容器到宿主网关访问。
- 每个 NapCat WebUI 都使用注册表分配的独立回环端口，首个账号默认为 `6099`。
- NapCat 不进入 Core 镜像、Core 容器、Native Core 进程单元或 Native 组件包。
- 跨组件出站媒体默认使用 OneBot `base64://`；禁止用共享卷或相同挂载点代替传输契约。
- 平台差异只存在于 `apps/*` 组合根、明确的 platform adapter、`tooling/runtime/` 和 `deploy/`。

## 3. 代码结构

```text
sunabot/
├── sunabot.sh                         # 唯一人工运行入口
├── apps/
│   ├── api/                            # Core composition root、HTTP 与 OneBot listeners
│   └── admin-web/                      # Vue 管理台
├── services/
│   ├── agents/                         # Agent 注册、运行时管理与 repository port
│   ├── agent/                          # 人格、最终提示词与公共 API
│   ├── messaging/                      # 命令、hook 与消息用例
│   ├── conversations/                  # 会话目录与显示名
│   ├── sessions/                       # 事件、turn、deferred job 与 outbox
│   ├── orchestration/                  # 回复门控、群聊编排和广播风暴
│   ├── memory/                         # 工作记忆、长期记忆、用户画像与调度
│   ├── media/                          # 附件与文档内容
│   ├── tools/                          # Agent 工具目录与执行
│   ├── delivery/                       # 出站媒体边界
│   └── webChat/                        # Web delivery adapter
├── adapters/
│   ├── onebot/                         # OneBot 连接、事件、action 和 QQ 媒体
│   ├── model/                          # Provider 协议、模型发现与图像输入
│   ├── codex/                          # Codex CLI adapter
│   ├── sqlite/                         # schema、业务存储、模型聚合和管理会话
│   └── notifications/
├── packages/
│   ├── contracts/                      # 跨模块版本契约
│   ├── platform/                       # workspace、代理与运行 Agent 上下文
│   └── testkit/
├── src/
│   ├── runtime.ts                      # 运行时组合层
│   ├── runtime/                        # intake、reply、delivery 等用例分片
│   └── admin/                          # 管理配置和 Agent 文件服务
├── components/napcat/                       # NapCat 镜像与组件锁说明
├── deploy/
│   ├── runtime-contract.json
│   ├── docker/                         # Core 镜像和按账号实例化的 NapCat 模板
│   └── native/                         # 仅 Native Core 内部启动资产
├── tooling/
│   ├── runtime/                        # 统一 launcher、doctor、contract 和 release
│   ├── migrations/                     # SQLite、workspace 和多 Agent 迁移
│   └── workspace/                      # 初始化、恢复点 v2、演练和同步
├── tests/
└── workspace/                               # 终端私有，不进入 Git
```

`src/runtime.ts` 只组合运行用例。Agent 注册表依赖 `AgentRegistryRepository`，由 API composition root 注入 SQLite adapter。请求日志与模型聚合存储与主业务 store 拆分，schema 迁移保持独立入口。

## 4. 运行拓扑

```text
宿主机 ./sunabot.sh
├── Sunabot Core × 1（Native 或 Docker）
│   ├── 127.0.0.1:8787 管理 API 与管理台
│   ├── :8788 OneBot v11 反向 WebSocket
│   ├── AgentRuntimeManager
│   │   └── 每个启用 Agent 一套 SunaRuntime / SessionCoordinator
│   └── Plana 注册主库 + 每个 Agent 独立双库
└── NapCat Docker × 已启用 QQ 账号
    ├── 每个账号独立 Compose project 与容器
    ├── 每个账号独立 WebUI 端口
    └── 每个账号独立配置、QQ 登录态和运行标记
```

`deploy/docker/compose.yml` 中的 `napcat` 是单账号模板。Launcher 从 Plana 注册主库读取已启用账号，为每个账号设置 `NAPCAT_ACCOUNT_ID`、QQ 号和 WebUI 端口，再使用独立 Compose project 启动容器。容器标签保留 workspace 身份、组件和 `account-id`，用于启停与冲突检测。

### 4.1 OneBot 连接

| Core 模式 | NapCat 连接地址 | 网络边界 |
| --- | --- | --- |
| Docker | `ws://core:8788/onebot/v11/ws?account_id=<accountId>` | Compose 私有网络 |
| Native | 启动器选择的 `ws://<host-gateway>:8788/onebot/v11/ws?account_id=<accountId>` | 同机容器到宿主网关 |

两种模式共用 access token、路径和 OneBot v11 消息语义。`account_id` 是账号到 Agent 唯一归属的路由键，不得由 QQ 显示名或容器名推断。

### 4.2 媒体与文件

`MediaAssetRef` 表达文件身份、类型、大小和内容来源，不向业务层暴露组件本地绝对路径。出站图片经边界校验后编码为 `base64://`。超过内联预算的大文件要增加鉴权、限流、过期和内容长度校验契约。NapCat 容器内路径不能进入 Core 业务层。

## 5. workspace 与数据所有权

```text
workspace/
├── business/
│   ├── config/sunabot.json                    # Provider、共用开关、Plana 默认配置
│   ├── migrations/multi-agent-v1.json         # 首次安装或单 Agent 迁移完成标记
│   ├── prompts/                               # 公共系统提示词
│   ├── data/
│   │   ├── sunabot.sqlite                    # Plana 业务库 + Agent 注册表
│   │   └── session-queue.sqlite               # Plana 队列库
│   ├── agents/
│   │   ├── plana/                             # Plana 人格、提示词、自拍资产
│   │   └── <agentId>/
│   │       ├── agent.json
│   │       ├── 人格、提示词、自拍资产
│   │       └── data/{sunabot.sqlite,session-queue.sqlite}
│   └── media/                                 # 需随业务恢复的媒体
├── runtime/
│   ├── napcat/accounts/<accountId>/
│   │   ├── config-full/                       # 该 QQ 的 NapCat 与 OneBot 配置
│   │   ├── qq/                                # 该 QQ 的登录态
│   │   ├── plugins/
│   │   ├── account.env
│   │   └── 二维码、人工登录和运行标记
│   ├── logs/
│   └── tmp/
├── cache/
├── secrets/
└── backups/
```

| 所有者 | 可读写范围 |
| --- | --- |
| Core | `business/`、`cache/`、`secrets/`、Core 日志与临时目录 |
| 某 Agent 运行时 | 该 Agent 的人格、业务库、队列库、媒体和可写 workspace |
| 某 NapCat 容器 | `runtime/napcat/accounts/<accountId>/` |
| Launcher | 公共运行配置、注册账号的 NapCat 配置、运行标记和组件生命周期 |

Plana 保留 `business/data/` 的历史稳定路径，同时承担 Agent 和 QQ 账号注册主库。其他 Agent 的业务数据只写入自己的 `data/` 双库。

## 6. 统一运行模型

`deploy/runtime-contract.json` 定义 Node 版本、端口、服务模板、组件锁、健康检查、隔离能力和资源上限。它对 NapCat 声明的 `6099` 是起始 WebUI 端口，实际账号端口以 `agent_accounts.webui_port` 为准。

`./sunabot.sh` 支持：

```text
up | down | restart | status | logs | doctor
```

`SUNABOT_CORE_MODE=auto|native|docker` 选择 Core：macOS `auto=native`，WSL2/Linux `auto=docker`。`--dev` 只用于 Native Core 开发。

当前启动顺序：迁移标记门禁与空目录首次标记 → workspace 布局初始化 → 密钥与管理凭据 → Core 启动与健康检查 → 从注册主库读取已启用 QQ 账号 → 逐账号写入 OneBot 配置并启动 NapCat 容器 → 写入 launcher state。停止顺序为全部 NapCat 账号 → Core → 清理 launcher state。

新增、启停或移除 QQ 账号后，宿主 account runtime daemon 按注册表调和目标 NapCat 容器；Docker Core 通过 workspace request/result bridge 请求宿主执行，不挂载 Docker socket。管理台显示期望状态、实际状态、调和需求和最近错误，容器尚未进入扫码态时不能伪造二维码就绪状态。注册库不可读时必须失败关闭，不能生成停止或删除计划。

## 7. Native 与发行边界

Native 模式只在宿主环境运行 Sunabot Core。`deploy/native/bin/start-sunabot.sh` 是 launcher 或进程管理器使用的 Core 内部入口，不负责 NapCat。

当前 Linux 发行包保留根 `sunabot.sh`、统一 launcher、预构建 Native Core、生产依赖、Docker Compose 与完整 Core 构建上下文、workspace 与迁移工具、迁移门禁和文档。发行资产中已取消 Native NapCat 启动脚本、NapCat systemd unit、runtime target、平行 Native 编排器、独立 NapCat 导出入口和旧单账号配置命令。历史服务器上已安装的旧 unit 仍需在迁移窗口显式停用，命令保留在 `docs/migrations/one-container-to-split-runtime.md`。

## 8. 迁移与恢复架构

迁移顺序固定为：

1. 识别现有运行形态和真实 workspace，记录代码 revision、容器、挂载与端口。
2. 停止 Core 和全部 NapCat，禁用旧自动重启单元，确认无写入。
3. 在任何写入前建立完整 workspace 原始布局离线归档并复验。
4. 执行 workspace 布局迁移；规范双库出现后立即创建并复验 SQLite 恢复点，再依次执行 JSON/JSONL 到 SQLite 迁移和单 Agent 到多 Agent 迁移。
5. 在停服状态创建新结构的恢复点 v2，然后通过统一 launcher 启动。
6. 验收每个 Agent 的双库、每个 QQ 的容器与定向外发，完成冷启动后再进入稳定观察。

恢复点 manifest v2 从 Plana 注册主库与 `business/agents/*/data` 文件系统扫描的并集确定范围，覆盖启用和停用 Agent 的业务库与队列库。注册缺库、单边数据库、未注册孤儿库、非法 Agent ID、符号链接或路径越界会让备份失败。v1 manifest 可继续校验和恢复，它只代表历史 Plana 双库范围。

## 9. 迁移启动门禁

- workspace 初始化、launcher、probe、API 组合根、AgentRegistry、first-run、账号 daemon 和单 Agent 迁移器在 marker、配置、凭据、SQLite、注册表或运行目录写入前共用完整父链路径门禁，并校验 `business/migrations/multi-agent-v1.json`。真正空目录原子写入 `fresh-install` 标记；首次运行用 HMAC journal 记录 marker、主库、queue、manifest、注册行和账号目录边界，受控中断后可以继续或回滚，未知文件保持原样。完成前必须校验当前主库与 queue schema、关键表列、约束、外键、索引、全部 Agent/QQ 注册状态和 Plana/primary 基线。既有目录缺少标记、标记格式或摘要无效、父链或必需路径含用户符号链接、任一注册状态不一致时稳定拒绝，且不补建当前结构。
- 完整注册状态包含每个 Agent 的规范 workspace 与 manifest、非 Plana Agent 的双库、每个 QQ 的三个 NapCat 运行目录，以及不可删除的 Plana/primary 基线。`completed-migration` 还固定核对目标 Agent workspace 和 primary WebUI 端口，所有必需路径都拒绝符号链接穿越；迁移后新增的合法 Agent 与账号继续纳入完整集合校验。
- `migrate:multi-agent --apply --quiesced` 在写入业务结构前核对 Native PID、配置与固定端口、全部账号端口和当前 workspace 的全部活动容器，再创建并复验 SQLite 恢复点；完成记录数、文件哈希、SQLite 与完整注册状态校验后写入迁移报告，再原子写入绑定恢复点 ID、恢复 manifest、报告、源状态与目标注册信息的 `completed-migration` 标记。报告分别以 `copiedRuntimeEntries`、`preservedRuntimeDivergences`、`copiedSystemPrompts` 与 `preservedSystemPromptDivergences` 记录实际复制和保留差异，运行目录差异绑定旧源与当前目标两侧类型及哈希，apply 后复验目标未变化。
- 结构已经就绪但缺少标记时，dry-run 仍返回 `ready`。操作者必须停服执行 apply，重新建立恢复点并封存完成标记；`already-migrated` 只在标记、全部 Agent manifest 与双库、注册表和全部账号运行目录同时通过校验后返回。

## 10. 完成标准

| 目标 | 证明材料 |
| --- | --- |
| 单入口启停 | 三个支持平台只使用 `./sunabot.sh`，依赖缺失时返回明确状态 |
| Core 形态唯一 | 同一 workspace 只有一个 Native Core 或 Docker Core，无分裂写入 |
| 账号容器隔离 | 每个已启用 QQ 拥有独立容器、账号目录、标签和 WebUI 端口 |
| Agent 数据隔离 | Plana 和其他 Agent 的业务库、队列库、人格和统计按规范分开 |
| OneBot 安全路由 | 专用 8788、token 强制、`account_id` 唯一归属、无公网发布 |
| 文件系统解耦 | 图文消息通过，OneBot action 和业务记录无 Core/NapCat 跨组件绝对路径 |
| 全 Agent 数据可恢复 | manifest v2 范围、SHA-256、SQLite 完整性、外键、队列投递不变量和隔离恢复演练通过 |
| 切换安全 | 旧新运行时无并行，迁移报告存档，旧代码、完整归档与 SQLite 恢复点可回滚 |
| 发行包收口 | 含 Core 双模式和 NapCat Docker 编排所需资产，无 Native NapCat、旧 systemd unit 或平行人工入口 |
