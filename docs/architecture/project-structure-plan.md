# sunabot 项目结构与运行架构

日期：2026-07-12
状态：当前演进目标
当前事实：`docs/specs/current-system-spec.md`
执行入口：`docs/todo.md`

## 1. 目标

工程同时满足：

1. macOS 开发完成的业务代码，在 macOS、Windows WSL2 和 Linux 拉取后通过 `./sunabot.sh up` 启动。
2. Sunabot Core 保持模块化单体，业务模块、运行组件、终端数据和开发工具拥有清晰边界。
3. NapCat 始终作为独立 Docker 组件；Core 可以 Native 或 Docker，运行形态不改变业务代码、SQLite schema 和 workspace 格式。
4. OneBot、媒体和文件协议跨文件系统边界工作，不依赖容器共享路径。
5. 任何升级都能停服、备份、验证和回滚，旧新运行时不能同时写同一 workspace。

Windows 主机通过 WSL2 运行，不承诺 Windows Native。NapCat 镜像支持的架构由 `components/component.lock.json` 和 contract 门禁决定。

## 2. 不可破坏的约束

- 增长型业务数据写入 SQLite；禁止恢复会话、消息、记忆、调度、日志或历史索引的 JSON/JSONL 持久化。
- 数据库 schema 只允许前向迁移，不能删除数据库重建。
- `workspace/` 整体不进入 Git；凭据、QQ 登录态、数据库、日志、缓存、生成图片和备份不得进入源码包。
- 管理台只发布到宿主回环 `127.0.0.1:8787`。
- OneBot 使用专用 `8788` listener 和强制 access token，只允许 Compose 私有网络或同机容器到宿主网关访问。
- NapCat WebUI 只发布到宿主回环 `127.0.0.1:6099`。
- NapCat 不进入 Core 镜像、Core 容器、Native release 或 systemd 进程组。
- 跨组件媒体默认使用 OneBot `base64://`；禁止共享绝对路径和隐式相同挂载点。
- 平台差异只能存在于组合根、平台 adapter、`tooling/runtime/` 与 `deploy/`。

## 3. 目标结构

```text
sunabot/
├── sunabot.sh                        # 唯一人工运行入口
├── AGENTS.md                         # 规范与任务索引
├── apps/
│   ├── api/                          # Core composition root 与 HTTP/WS listeners
│   └── admin-web/                    # Vue 管理台
├── services/                         # 核心业务模块
│   ├── messaging/
│   ├── conversations/
│   ├── sessions/
│   ├── orchestration/
│   ├── memory/
│   ├── media/
│   ├── tools/
│   ├── delivery/
│   └── agent/
├── adapters/
│   ├── onebot/
│   ├── model/
│   ├── codex/
│   ├── sqlite/
│   └── notifications/
├── packages/
│   ├── contracts/
│   ├── platform/
│   └── testkit/
├── components/
│   └── napcat/                       # 外部 Docker 组件锁与说明
├── deploy/
│   ├── runtime-contract.json
│   ├── docker/                       # Core 与 NapCat 两个服务
│   └── native/                       # Core Native 资产
├── tooling/
│   ├── runtime/                      # 统一 launcher、doctor 与配置器
│   ├── migrations/
│   ├── workspace/
│   ├── quality/
│   └── benchmarks/
├── tests/
└── workspace/                        # 终端私有，不进入 Git
```

业务模块只通过公开 port 与 versioned contract 协作。`src/runtime.ts` 负责生命周期和用例编排，不能重新聚合媒体传输、平台判断或具体 Docker 操作。

## 4. 组件通信

### 4.1 OneBot

| Core 模式 | NapCat 连接地址 | 暴露方式 |
| --- | --- | --- |
| Docker | `ws://core:8788/onebot/v11/ws` | Compose 私有网络 |
| Native | 启动器生成的 `ws://<host-gateway>:8788/onebot/v11/ws` | 同机容器到宿主网关 |

两种模式都使用相同 access token、路径和 OneBot v11 消息语义。Core 的管理 listener 与 OneBot listener 独立，不能为容器可达性扩大管理台监听范围。

### 4.2 媒体与文件

`MediaAssetRef` 表达文件身份、类型、大小和内容来源，不表达某个进程的本地绝对路径。出站图片经边界校验后编码为 `base64://`。大文件若超过内联预算，需要新增带鉴权、限流、过期和内容长度校验的传输 contract；共享卷不能作为替代协议。

入站 QQ 文件必须由 OneBot 提供 Core 可读取的数据、受控 URL 或明确流式接口。NapCat 容器路径不能进入业务层。

## 5. 数据边界

```text
workspace/
├── business/
│   ├── config/
│   ├── agents/
│   ├── data/
│   └── media/
├── runtime/
│   ├── napcat/
│   │   ├── config-full/
│   │   ├── qq/
│   │   └── plugins/
│   ├── logs/
│   └── tmp/
├── cache/
├── secrets/
└── backups/
```

Core 持有 `business/`、主库和 session queue；NapCat 只挂载 `runtime/napcat/`。启动器可以生成 NapCat 配置，但 Core 业务代码不能读取 QQ 登录目录。备份必须在停服或 SQLite 一致恢复点上执行；NapCat 登录态与业务库均需保留，但恢复时保持各自目录边界。

## 6. 运行模型

`deploy/runtime-contract.json` 定义 Node 版本、端口、路径、服务名、健康检查、资源限制和组件锁。`./sunabot.sh` 读取该契约并提供：

```text
up | down | restart | status | logs | doctor
```

`SUNABOT_CORE_MODE=auto|native|docker` 选择 Core。macOS `auto=native`，WSL2/Linux `auto=docker`。`--dev` 只用于 Native Core 开发，启动 API watch 与 Vite；生产式启动使用构建产物。

启动顺序：workspace 与秘密检查 → Core → Core health → NapCat 配置 → NapCat Docker → OneBot/QQ readiness。停止顺序：NapCat → Core。首次 QQ 登录可以报告 `awaiting-login`，不能把人工扫码误判为启动失败。

同一 workspace 只允许一个 launcher 身份、一个 Core 和一个 NapCat。doctor 必须检测端口 owner、workspace realpath、数据库路径、Compose labels、OneBot connection owner 和遗留进程。

## 7. 演进顺序

1. 固化独立 listener、token、媒体和 workspace 组件边界。
2. 建立统一 launcher、双服务 Compose、模式选择与 doctor。
3. 将 Core 镜像收敛为纯 Core，NapCat 使用独立锁定镜像。
4. 迁移旧服务端，保留 SQLite、业务媒体和 NapCat 登录态；验证后删除旧入口。
5. 继续按 messaging、delivery、memory、media、provider 和 HTTP 路由拆分模块。
6. 完成容量基准、故障注入、备份恢复和跨模式 contract test。

运行形态切换不能和数据库语义修改混在一次不可回滚操作中。旧服务端切换流程见 `docs/migrations/one-container-to-split-runtime.md`。

## 8. 完成标准

| 目标 | 证明材料 |
| --- | --- |
| 单入口启动 | 三个平台从 clean checkout 执行 `./sunabot.sh up`，依赖缺失时返回可执行提示 |
| 组件分离 | Compose 中 Core 与 NapCat 是两个服务、两个镜像和独立生命周期 |
| OneBot 安全 | 管理台回环、OneBot 专用端口、token 强制、无公网发布 |
| 文件系统解耦 | 文图消息通过；OneBot action 中没有 Core/NapCat 绝对路径 |
| 模式可移植 | Native Core 与 Docker Core 使用同一业务测试、SQLite fixture 和 workspace |
| 数据可靠 | checkpoint、备份、恢复、完整性、记录数和队列不变量通过 |
| 切换安全 | 旧新运行时无并行，失败可恢复旧镜像、配置与 workspace 快照 |
| 开发体验 | macOS `./sunabot.sh up --dev` 支持快速迭代，生产式模式可在本机验证 |
