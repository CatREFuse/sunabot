# sunabot 项目结构与模块化演进计划

日期：2026-07-11
状态：待实施的目标架构
执行入口：`docs/todo.md`
现状规范：`docs/specs/current-system-spec.md`

> 本文描述目标结构和迁移顺序，不覆盖当前系统规范。每个阶段只有在代码、数据迁移、验证和规范索引同时落地后，才能成为新的当前事实。

## 1. 目标与结论

整理后的工程必须同时满足：

1. 核心业务代码、业务数据、Codex Web Coding 开发脚手架、外部依赖组件在目录和生命周期上分离。
2. 源码、配置、数据、秘密、缓存、运行状态和备份各自有唯一边界，不再由当前工作目录隐式决定。
3. 核心业务采用“模块化单体 + 微服务边界”的实现：一个 Sunabot 进程内按高内聚模块组织，通过版本化端口、命令和事件协作，不在进程内制造 HTTP 网状调用。
4. Linux/WSL Native 与 Docker 使用同一发布产物、同一运行契约、同一 workspace 结构和同一验收脚本。
5. Docker 交付收敛为一个镜像、一个容器、一个数据卷。容器内 Sunabot 与 QQ/NapCat 仍是两个受监督进程；“单容器”不等于把两者揉成一个进程。
6. 不再允许超级单体服务文件、跨模块直接访问内部表、未版本化的持久化消息或双重工具注册源。

支持范围定义为 Linux Native（包含 WSL2）和 Linux Docker。Windows 主机通过 WSL2 运行，不承诺直接 Windows Native。当前 NapCat 镜像为 amd64，arm64 支持必须由依赖清单和构建门禁单独证明。

## 2. 不可破坏的系统约束

- OneBot v11 仅是 QQ Runtime 内部协议，NapCat 通过回环反向 WebSocket 连接，不支持远程 OneBot。
- Native 与 Docker 内部都只使用固定 workspace 根和回环地址，不依赖 `host.docker.internal`、容器 DNS 或局域网地址。
- 增长型业务数据继续写 SQLite；禁止恢复会话、消息、记忆、调度、日志或历史索引的 JSON/JSONL 持久化。
- 数据库 schema 只允许前向迁移，不能通过删除数据库重建。
- `workspace/` 整体不进入 Git；明文凭据、QQ 登录态、数据库、日志、缓存、生成图片和备份不得进入源码包。
- 目录迁移不能和业务语义修改混在同一提交；每个迁移阶段必须有兼容适配器、回滚点和独立验证。

## 3. 当前结构审计

### 3.1 代码架构问题

| ID | 优先级 | 证据 | 影响 | 改进方向 |
| --- | --- | --- | --- | --- |
| ARC-001 | P1 | `src/runtime.ts` 4,707 行，`SunaRuntime` 类约 2,917 行，31 个 import、104 个方法 | intake、回复、群聊编排、记忆、持久化、外发和自拍共享状态，修改任一能力都扩大回归面 | 拆为 messaging、reply、orchestration、memory-pipeline、delivery、conversation 等模块；Runtime 仅保留生命周期和用例编排 |
| ARC-002 | P1 | 持久化 event、tool completion 和 outbox payload 定义在 `runtime.ts` 私有接口中，无 `schemaVersion`，恢复时依赖强转和零散判断 | 重构或重启后存在协议漂移和无法迁移的风险 | 建立 `contracts/session/v1` discriminated union、统一 codec、运行时校验和前向迁移 |
| ARC-003 | P1 | `src/openaiProvider.ts` 1,542 行，同时处理 transport、工具 dispatch、图片、重试、SSE/JWT 和日志 | Provider、工具和媒体互相牵连；难以替换或单测 | Provider 只实现 `ModelGateway`；统一 `ToolRegistry`、`ToolExecutor` 和 media writer |
| ARC-004 | P1 | 工具管理元数据来自 `src/tools.ts`，模型工具和执行器在 `openaiProvider.ts` 另行拼装；已有 `bash.run` 与 `workspace_bash` 名称不一致 | UI、权限、模型 schema 和真实执行能力会漂移 | 单一 ToolRegistry 同时产出名称、schema、权限、状态和 executor，并校验 definition/executor 成对 |
| ARC-005 | P1 | `src/server.ts` 968 行，`buildApp` 约 501 行，集中组装实例并注册 41 条路由；大量 body/query/params 强转 | HTTP contract、应用服务和基础设施混在第二组合根 | Composition Root 只装配；路由按 auth、conversation、onebot、memory、media、provider 拆 Fastify plugin，并使用固定 schema |
| ARC-006 | P1 | `src/memory.ts` 1,717 行，混合管理 CRUD、领域合并、事务、召回、Tool schema、Agent 文件 I/O，并反向依赖 `admin/*` | 领域层被 HTTP/管理适配层污染 | 按 domain、application、ports、repository、recall、admin adapter、tool adapter 拆分 |
| ARC-007 | P1 | OneBot delegate 把具体 `OneBotGateway` 传进 Runtime，业务方法直接调用 Gateway | 业务核心依赖 transport 细节，无法用其他适配器或纯内存端口测试 | OneBot adapter 只输出 `InboundMessageV1`；业务依赖 `MessagingPort`，CQ/OneBot 解析留在 adapter |
| ARC-008 | P2 | `applicationDataStore()` 是全局 service locator；一个 store 横跨会话、记忆、调度、图片和日志 | 所有模块可绕过边界直接访问具体 SQLite 实现 | 共享 connection/unit-of-work，但按 bounded context 暴露 repository port；禁止跨模块内部表访问 |
| ARC-009 | P2 | `src/types.ts` 同时包含 Provider、配置、OneBot、会话和图片类型，内部 fan-in 很高；`ParsedIncomingMessage` 嵌入原始 OneBot event | 公共类型桶放大耦合，transport 泄漏到领域层 | 类型随模块和 contract 归属；shared kernel 只保留 ID、Clock、Result 等稳定 value object |
| ARC-010 | P2 | `attachments/service.ts`、`attachments/cache.ts` 仍超过千行 | 已形成 bounded context，但 fetch、CAS、index、清理和解析仍互相耦合 | 保持一个 media 模块，内部拆 fetcher、content store、index repository、janitor、parser pipeline |
| ARC-011 | P2 | 没有模块 import 规则、持久化协议 codec 门禁或文件/类体量预算 | 目录整理后容易重新长成单体 | 增加 architecture test，检查依赖方向、循环、public API、协议版本和体量阈值 |

量化基线：后端当前 59 个 TypeScript 文件、约 25,578 行；前五大文件约占 41.9%。除一个 type-only import 环外，当前没有可执行循环依赖。`SessionCoordinatorOptions` 的 callback ports 和 `CodexRunner` 是可保留并推广的现有好边界。

### 3.2 性能与可靠性问题

| ID | 优先级 | 当前问题 | 改进方向与验收指标 |
| --- | --- | --- | --- |
| PERF-001 | P1 | `DatabaseSync` 在主线程执行；消息到达后会重排并重写最多 80 个会话、每会话最多 2,000 条消息 | `conversation_messages` 增量表 + 有界写队列/worker；2,000 消息持久化 p95 `<20 ms`，事件循环 p99 `<50 ms` |
| PERF-002 | P1 | 记忆调度每次遍历历史并整体读写调度状态 | 待处理消息、游标、批次行级存储；80 会话并发时写放大接近 1 |
| PERF-003 | P1 | SessionCoordinator 会循环 claim 到空，但实际 actor 并发有限；内存队列和续租 timer 无有界 prefetch | claim 数量不超过可用槽位的 1–2 倍；10 万积压时 RSS 有上界，并暴露 backlog/oldest-age |
| PERF-004 | P1 | 附件 chunks 在主线程同步 `.all()` 后才筛选；大文件会全量读取与解析 | SQL `LIMIT`/FTS5 top-K 或移到 worker；20M 字符文件查询不随总块数线性增长 |
| PERF-005 | P1 | 请求日志与队列终态只增不清，日志搜索为 `%query%` 全表扫描 | FTS5、游标分页、时间过滤、保留策略、终态归档和定期 checkpoint；10 万/100 万日志有 p95 基线 |
| PERF-006 | P1 | 记忆召回每次全量读取、分词、排序 | FTS5 或可增量索引；10 万记录 recall p95 `<200 ms`，语义回归一致 |
| PERF-007 | P1 | OneBot 单帧上限 384 MiB，先转字符串再 JSON.parse，入口事件没有明确背压 | 按真实协议缩小上限、禁止大文件 base64 内联、加入有界 intake；1,000 消息突发不产生无界 backlog |
| PERF-008 | P1 | 关键会话写失败仅记录日志；主库与 queue DB 又是两个事务域 | 必需写失败进入 turn 故障/重试，日志降级有 drop counter；补 SQLITE_BUSY、磁盘满、kill -9 故障注入 |
| PERF-009 | P1 | 没有周期 SQLite 在线备份、统一恢复点或恢复演练 | 每日一致性 backup、7/30 天保留和季度恢复；RPO `≤24h`，恢复后完整性与队列不变量通过 |
| PERF-010 | P2 | 图片页同步扫描/stat 全目录；4K 图片同步 base64 解码写盘；附件索引全量重写 | 图片/缓存 SQLite 索引、异步流式写或 worker、后台目录核对；1 万图片列表 p95 `<200 ms` |
| PERF-011 | P2 | Sender cache、hydrated message IDs、incoming preparations 等缓存缺容量或完整 TTL 生命周期 | 统一 bounded TTL/LRU 和指标；72 小时 soak test RSS 不持续增长 |
| PERF-012 | P2 | 会话页固定轮询，记忆页全量加载和全量渲染 | cursor/SSE、single-flight、服务端分页/搜索和虚拟列表；空闲页面 QPS 接近 0 |
| PERF-013 | P2 | 容器没有日志轮转、memory/CPU/pids 预算；附件 worker 单项预算较高 | 资源和日志上限、磁盘告警、OOM 演练、固定 runtime 版本和 SBOM |

### 3.3 工程、数据与部署问题

| ID | 优先级 | 当前问题 | 改进方向 |
| --- | --- | --- | --- |
| OPS-001 | P1 | 当前 Compose 是 Sunabot、NapCat 两个容器，Sunabot Dockerfile 不包含 NapCat | 构建单一 QQ Runtime 镜像，单 service/单容器内监督两个进程 |
| OPS-002 | P1 | Native 生产使用未入库的两个 user systemd unit；NapCat 安装和 QQ 状态位于用户主目录，而 Docker 使用 `workspace/napcat` | Native unit、安装器、组件版本和状态路径全部入库，统一 runtime contract 与 workspace |
| OPS-003 | P1 | 审计时 Windows 与 WSL 都存在 8787 listener，可能出现双实例、workspace 分裂和入口归属不明 | 增加 `runtime doctor`：检查唯一实例、端口 owner、workspace identity、DB 路径/inode 和 OneBot owner；启动前阻止 split-brain |
| OPS-004 | P1 | `workspace/` 内混合业务数据、秘密、NapCat 状态、缓存、临时文件和开发审计产物；同步脚本接近整目录打包 | 按 business/runtime/secrets/cache/backups 分层；业务、运行态和秘密使用不同快照策略，cache/tmp 永不备份 |
| OPS-005 | P1 | 源码和多个脚本以 `process.cwd()` 推导代码根/数据根 | 代码根由 `import.meta.url` 或安装前缀决定；数据根只由 `SUNABOT_WORKSPACE` 决定，禁止 cwd fallback 进入生产 |
| OPS-006 | P1 | Docker 与 Native 能力矩阵不一致；当前容器只复制构建产物且未安装 Codex CLI，Native 启动资产也未版本化 | 同一 release artifact、preflight、configure、health、stop 和 capability contract 驱动两种 adapter |
| OPS-007 | P1 | `package.json` 要求 Node 24，CI 却使用 Node 22 | CI、Native 和 Docker 固定同一已验证 Node 24 小版本 |
| OPS-008 | P2 | Node 与 NapCat 镜像只锁 tag、未锁 digest；非 npm 组件缺少来源、校验和、许可证和架构清单 | `component.lock.json` 固定版本、digest、checksum、source、license、architecture 和 smoke test |
| OPS-009 | P2 | 14 个脚本平铺，Codex Web Coding 脚手架没有独立目录 | 脚本按 runtime、workspace、migration、quality、admin 分类；根 `AGENTS.md` 只保留发现入口 |
| OPS-010 | P2 | 根 package 同时包含 API 与 Web 运行依赖，prune 后仍会把纯前端依赖带进服务镜像 | 构建产物和依赖按 API/Web 分离，容器只复制 API production closure 与 Web 静态产物 |

## 4. 目标项目结构

```text
sunabot/
├── AGENTS.md                         # Codex 发现入口，只索引规范与 tooling
├── apps/
│   ├── api/                          # 唯一 composition root、Fastify plugins、启动入口
│   └── admin-web/                    # Vue 管理台
├── services/                         # 核心业务模块；同进程部署，边界按微服务标准维护
│   ├── messaging/                    # inbound canonicalization、去重、路由、gate
│   ├── conversations/                # 会话、上下文、参与者与目录
│   ├── sessions/                     # event、turn、tool job、outbox 状态机
│   ├── reply/                        # 直接回复、上下文组装、prompt request
│   ├── orchestration/                # 用户群编排、ambient reply、群聊总结
│   ├── memory/                       # 工作记忆、长期记忆、画像、召回与调度
│   ├── media/                        # 附件、图片、自拍与内容缓存
│   ├── tools/                        # ToolRegistry、权限、执行与异步任务
│   ├── delivery/                     # OutboundMessage、重试、媒体引用
│   └── agent/                        # 人格、提示词与 Agent 文件
├── adapters/
│   ├── onebot/                       # OneBot v11/CQ/QQ 文件与 MessagingPort
│   ├── model/                        # OpenAI/Codex model gateway
│   ├── codex/                        # Codex CLI process adapter
│   ├── sqlite/                       # 各 bounded context repository + unit of work
│   ├── filesystem/                   # workspace、media、cache、Agent 文件
│   └── notifications/                # Bark 等外部通知
├── packages/
│   ├── contracts/                    # versioned DTO、event、command、port、codec
│   ├── platform/                     # config、clock、logging、metrics、path primitives
│   └── testkit/                      # fake ports、fixtures、contract tests
├── components/                       # 非 npm 运行依赖；不放业务代码
│   ├── napcat/
│   ├── codex-cli/
│   └── document-runtime/             # LibreOffice、字体与转换能力清单
├── deploy/
│   ├── runtime-contract.json         # 路径、端口、组件、健康和能力唯一契约
│   ├── docker/                       # 单镜像、单 service、进程监督器
│   └── native/                       # tarball、systemd units/target、安装与卸载
├── tooling/
│   ├── codex/                        # Codex Web Coding bootstrap、工作指南、检查入口
│   ├── dev/                          # 本地启动和 fixture
│   ├── quality/                      # check、architecture、contract、license、SBOM
│   ├── benchmarks/                   # 性能、故障注入与 soak
│   ├── migrations/                   # schema 与 workspace 前向迁移
│   └── workspace/                    # 快照、恢复、doctor、备份
├── tests/                             # 按 service/adapter/contract/runtime 镜像
├── docs/
└── workspace/                         # 整体 Git ignore；只保存终端私有状态
```

迁移期间不立即引入多个网络服务或独立 npm 发布包。`services/*` 是可独立测试和拥有数据边界的模块，但由 `apps/api` 在同一 Node 进程中装配。只有在真实容量或故障隔离数据证明需要独立进程时，模块才升格为独立服务。

## 5. 模块所有权和依赖规则

| 模块 | 拥有的业务能力 | 唯一公开入口 | 不允许 |
| --- | --- | --- | --- |
| messaging | OneBot 无关的入站消息、去重、路由、回复门控 | `InboundMessagePort`, `InboundMessageV1` | 引用 `OneBotGateway`、SQLite、HTTP request |
| conversations | 会话元数据、消息、上下文、参与者 | `ConversationService`, `ConversationRepository` | 直接发送消息或调用 Provider |
| sessions | event/turn/tool/outbox 状态机与顺序 | `SessionQueuePort`, versioned event codec | 了解 OneBot、Prompt 或模型细节 |
| reply | 直接回复用例、上下文预算、prompt request | `ReplyService`, `ModelGateway` port | 直接写数据库或解析 CQ |
| orchestration | 群聊编排、ambient reply、总结 | `OrchestratorService` | 直接访问 transport 或具体 Provider |
| memory | 记忆领域规则、批次、召回、调度 | `MemoryService`, `MemoryRepository` | 依赖 `admin/*` 或 Fastify error |
| media | 附件、图片、自持有缓存和解析 pipeline | `MediaService`, `MediaAssetRefV1` | 把任意主机路径直接传出边界 |
| tools | 单一工具注册表、权限、同步/异步执行 | `ToolRegistry`, `ToolExecutor` | 在 Provider 内按名字写 switch dispatch |
| delivery | outbound message、重试、幂等和媒体引用 | `DeliveryService`, `MessagingPort` | 重新生成业务回复或访问 Provider |
| agent | 人格、提示词、Agent 文件 | `AgentProfilePort`, `PromptCatalog` | 访问会话队列或 OneBot |

依赖方向固定为：

```text
apps/api ──> services ──> packages/contracts
    │             ▲
    ├──> adapters ┘
    └──> packages/platform

deploy / components / tooling 不得被业务模块 import
```

- 每个模块只从 `public.ts` 导出稳定 API，跨模块禁止深层 import。
- contracts 不依赖 services、adapters、Fastify、SQLite 或环境变量。
- adapters 实现 services 定义的 port；services 不引用 adapter 具体类。
- SQLite 可以共享同一 connection 和事务，但 repository 只能访问所属表；跨模块写入通过显式 unit-of-work。
- 以 architecture test 强制上述规则，并检查循环依赖与 public API。

## 6. 固定协作协议

### 6.1 通用 envelope

所有持久化 command/event/outbox 使用统一 envelope：

```ts
interface EnvelopeV1<TType extends string, TPayload> {
  schemaVersion: 1;
  id: string;
  type: TType;
  occurredAt: string;
  conversationId?: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  payload: TPayload;
}
```

落库前和恢复时都必须经过同一个 codec；未知版本不能强转执行，只能进入明确的 dead/needs-migration 状态。

### 6.2 业务协议

| 边界 | 协议 | 传输 |
| --- | --- | --- |
| NapCat → onebot adapter | OneBot v11 reverse WebSocket | 回环 `127.0.0.1` |
| onebot adapter → messaging | `InboundMessageV1` | 进程内 port |
| messaging → sessions | `TurnRequestedV1` | SQLite durable event |
| sessions → reply/orchestration | `TurnCommandV1` | 进程内 handler + durable lease |
| reply/orchestration → tools | `ToolJobRequestedV1` / `ToolJobCompletedV1` | SQLite durable job/event |
| reply/orchestration → memory | `MemoryQueryV1` / `MemoryBatchV1` | 进程内 port，写入事务化 |
| reply/orchestration → delivery | `OutboundMessageV1` | SQLite outbox |
| delivery → onebot adapter | `MessagingPort.send()` | 进程内 port，adapter 转 OneBot action |

内部协议不使用 localhost HTTP。同步协作使用 typed port；需要重启恢复、重试和幂等的协作使用 SQLite durable envelope。

`OutboundMessageV1` 的媒体字段只能是经过校验的 `MediaAssetRefV1`。本地图片必须位于 runtime contract 允许的共享 media 根；OneBot adapter 才能把它转换为本地绝对路径。

## 7. 业务数据边界

目标 workspace：

```text
workspace/
├── business/
│   ├── config/                       # 无明文 secret 的应用配置
│   ├── agents/                       # 人格、Prompt、Agent 工作文件
│   ├── data/                         # 主库、队列库与可恢复业务索引
│   └── media/                        # 生成图片和持久业务附件
├── runtime/
│   ├── napcat/                       # QQ 登录态；配置固定在 config-full/
│   ├── logs/
│   └── tmp/
├── cache/                            # 可重建附件/解析缓存
├── secrets/                          # runtime.env、Codex auth、管理员秘密
└── backups/
```

快照分三级：

- `business`：默认备份，包含业务配置、Agent、SQLite 和持久媒体。
- `runtime`：可选备份，包含 NapCat 登录态；必须停进程并单独加密。
- `secrets`：独立密钥加密，不与普通业务快照使用同一密钥。
- `cache`、`runtime/tmp` 和测试/审计产物永不进入备份。

迁移必须由版本化 migrator 执行：停服、checkpoint、备份、复制、记录数与 checksum 校验、切换 runtime contract、重启验证。不能直接移动正在写入的 SQLite。

## 8. Native 与单容器运行模型

### 8.1 唯一 runtime contract

`deploy/runtime-contract.json` 是两种运行方式的共同输入，至少定义：

- release/version、支持架构和 Node 小版本；
- 代码安装前缀和 `SUNABOT_WORKSPACE`；
- OneBot URL、管理端口、NapCat WebUI 端口；
- media 根、NapCat 状态根、唯一 NapCat 配置目录 `runtime/napcat/config-full`、secret 文件；
- 组件版本、digest、checksum 和许可证；
- 启动顺序、优雅停止时间、liveness、readiness 和 capability probe。

代码根由 `import.meta.url`/安装前缀解析；数据根只由显式 `SUNABOT_WORKSPACE` 解析。生产路径禁止回退到 `process.cwd()`。

### 8.2 Native

- 从同一 release artifact 安装到 `/opt/sunabot/releases/<version>`，`/opt/sunabot/current` 原子切换。
- 入库 `sunabot-api.service`、`sunabot-napcat.service` 和 `sunabot-runtime.target`。
- NapCat 二进制、配置和 QQ 状态必须使用 component manifest 与 workspace 路径，不能落到开发用户主目录。
- `runtime install/start/stop/status/doctor/uninstall` 是唯一操作入口。

### 8.3 Docker

- multi-stage build 先构建 API/Web release artifact，再组合已锁定的 NapCat、Node、LibreOffice、字体和可选 Codex CLI。
- 最终只有一个 `sunabot-qq-runtime` image 和一个 Compose service；挂载一个 `/srv/sunabot/workspace` 数据卷。
- 使用 s6-overlay 或等价监督器管理 Sunabot 与 QQ/NapCat，正确转发 SIGTERM、回收子进程、按组件策略重启并输出分流日志。
- liveness 只判断监督器和 Sunabot 是否存活，避免 QQ 临时离线造成容器重启风暴；readiness 分层报告 API、OneBot connected、QQ online、Provider ready。
- 只向宿主机回环发布管理台与 NapCat WebUI；OneBot 无独立公开端口。
- 配置日志轮转、memory/CPU/pids/shm 预算和磁盘水位告警。

单容器发布前必须完成 QQ/NapCat 再分发许可证审查、镜像 SBOM、amd64 构建、非 root UID/GID、1 GiB shm、冷启动和异常子进程恢复测试。

## 9. Codex Web Coding 开发脚手架

- 根 `AGENTS.md` 继续作为 Codex 自动发现入口，但只保存规范、索引、边界和验证命令。
- `tooling/codex/` 保存 Web Coding bootstrap、常用任务、目录说明、提交检查和无秘密示例配置。
- `tooling/dev/` 提供跨 PowerShell/WSL 的短命令入口，不再依赖巨型混合 shell one-liner。
- `tooling/quality/` 统一运行 typecheck、unit、contract、architecture、license、SBOM 和 e2e。
- `tooling/benchmarks/` 保存 2,000 消息、10 万记忆/日志、10 万 queue backlog、大附件和 72 小时 soak 基准。
- 开发脚手架不得成为生产运行依赖；Docker runtime stage 不复制 `tooling/codex`、测试和 benchmark。

## 10. 迁移顺序

1. **门禁先行**：固定 Node 24 小版本、修复 CI、记录性能基线、引入 contract/architecture test 和 runtime doctor。
2. **协议先于移动**：把 persisted event/outbox/tool payload 与 ToolRegistry 固化成 versioned contract，不改变行为。
3. **数据访问分界**：repository ports、unit-of-work、增量消息表、行级 memory scheduler、bounded queue claim。
4. **按缝拆 Runtime**：先 delivery，再 messaging/intake、conversation、reply、orchestration、memory-pipeline、media；每步保留兼容 facade。
5. **拆第二组合根**：按领域拆 Fastify plugins，`apps/api` 只负责 wiring、生命周期和错误映射。
6. **整理物理目录**：移动 apps/services/adapters/packages/tests/tooling，保留 npm script 命令兼容层，并同步规范索引。
7. **Native 同构**：组件 manifest、workspace 路径、systemd units、release artifact 和 doctor 入库。
8. **单容器交付**：同一 artifact 构建单镜像，完成监督器、资源、信号、登录态和媒体路径验收。
9. **workspace 前向迁移**：最后迁业务/runtime/secrets/cache 分层，完成备份、恢复和回滚演练。

不能把第 4–6 步与第 8–9 步合并成一次“大搬家”。代码边界、运行形态和数据路径必须分批切换，保证每个提交都可部署和回滚。

## 11. 完成标准

| 目标 | 证明材料 |
| --- | --- |
| 四类边界分离 | 目标目录落地；业务模块不能 import deploy/components/tooling；workspace 整体不入 Git |
| 模块高内聚、外部解耦 | architecture test 全绿；跨模块只走 public port/contract；无具体 Gateway/DB 泄漏 |
| 无超级单体 | Runtime 只做组合；业务文件原则上 `<800` 行、类 `<500` 行，超限必须有 ADR 和拆分 TODO |
| 固定协议 | 所有持久化 event/job/outbox 有 schemaVersion、codec、兼容测试和未知版本处理 |
| Native 可运行 | clean Linux/WSL 安装、启动、停止、升级、回滚、冷启动和真实 QQ 文图消息通过 |
| 单容器可运行 | `docker compose config --services` 仅一个 service；容器内两个进程受监督；单 volume；真实 QQ 文图消息通过 |
| Native/Docker 同构 | 同一 runtime contract、release artifact、workspace fixture 和 contract test 在两种模式通过 |
| 数据可靠 | checkpoint、每日备份、恢复演练、kill -9/磁盘满/SQLITE_BUSY 不变量通过 |
| 性能达标 | 2,000 消息、10 万记忆/日志、10 万 queue backlog、大附件和 72 小时 soak 指标满足本文目标 |
| 开发体验 | 新 Codex 任务只需根 `AGENTS.md` + `tooling/codex`；一条命令完成 bootstrap 和 verify |
