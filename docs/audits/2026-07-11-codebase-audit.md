# sunabot 代码库审计与优化计划

日期：2026-07-11
范围：功能缺陷、依赖安全、性能、持久化、模块耦合和 WSL2 可迁移性

运行部署结论已于 2026-07-12 按当前系统规范更新；原始审计中关于组合镜像的建议不再适用。

## 已验证

| 检查 | 结果 |
| --- | --- |
| TypeScript 与 Vue 类型检查 | 通过 |
| 单元与集成测试 | 134 个测试文件、649 项测试通过 |
| 端到端测试 | 19 项通过，覆盖生产静态服务、鉴权、导航、主题、响应式、可访问性和核心管理操作 |
| 视觉回归 | 浅色/深色与 4 种视口矩阵通过，抽查移动端、桌面端主要页面无布局异常 |
| 生产构建 | Web 与 API 构建通过 |
| SQLite 隔离迁移 | 2,901 条请求日志、7 个会话、38 条记忆/画像、7 个调度会话、104 个附件分块迁移通过 |
| SQLite 完整性 | 主业务库与会话队列库均为 `integrity_check=ok`；主库 34,066,432 字节 |
| 请求日志查询基线 | 2,901 条日志、200 次 `%request%` 查询：中位数 3.605 ms，p95 3.861 ms，最大值 7.343 ms |
| 上线检查 | 管理页面与 4 个核心管理 API 返回 200，OneBot 反向连接 1 路在线 |
| 生产依赖审计 | 0 个已知漏洞 |
| 全依赖审计 | 0 个已知漏洞 |

## 问题表

| ID | 优先级 | 类型 | 现状与影响 | 优化目标 | 状态 |
| --- | --- | --- | --- | --- | --- |
| AUD-001 | P0 | 安全 | `@fastify/static` 旧版本存在目录遍历和编码路径绕过公告 | 升级到 9.3.0，并验证静态资源、深链接和鉴权 | 已修复 |
| AUD-002 | P0 | 迁移 | Provider 配置包含 macOS 绝对 `.env.local` 路径 | 统一使用项目相对 `.env` | 已修复 |
| AUD-003 | P1 | 安全 | Linux/WSL 与 Docker 已统一使用 fail-closed bubblewrap：宿主根只读、Agent workspace 唯一可写、子进程继承 mount/PID namespace 并丢弃 capability；Native 仍由独立用户和 systemd 文件限制包围 | 保持 bubblewrap 组件锁、namespace probe 和路径/符号链接/挂载/子进程回归门禁 | 已修复 |
| AUD-004 | P1 | 性能 | `DatabaseSync` 在主线程同步执行，请求日志和会话高频写入可能造成事件循环抖动 | 建立写入队列、批量提交和延迟指标，必要时迁到 worker | 待优化 |
| AUD-005 | P1 | 性能 | 请求日志查询使用 `%query%`，数据增长后需要全表扫描；当前没有保留上限 | 增加 FTS5、时间范围、分页、保留天数和按类别清理 | 待优化 |
| AUD-006 | P1 | 性能 | 会话每次保存会序列化所有当前会话，每个会话仍以完整消息数组 JSON 存在一行 | 拆分 `conversation_messages`，按消息增量写入并建立会话时间索引 | 待优化 |
| AUD-007 | P1 | 性能 | 记忆召回每次读取全部记录并在主线程执行 BM25 | 增加 FTS5 或预构建索引，并记录召回耗时与命中数 | 待优化 |
| AUD-008 | P1 | 性能 | `/api/images` 会同步扫描整个图片目录并读取每个文件状态 | 图片创建时更新索引，目录核对改为启动任务或手动修复 | 待优化 |
| AUD-009 | P1 | 耦合 | `src/runtime.ts` 4,707 行、31 个 import、104 个方法，同时承担接入、路由、上下文、记忆调度、工具结果、会话持久化、外发和自拍 | 按 messaging、conversation、reply、orchestration、memory-pipeline、delivery 拆模块，Runtime 仅保留生命周期与用例编排 | 待优化 |
| AUD-010 | P1 | 耦合 | `src/memory.ts` 1,717 行，混合 schema 规范化、合并、事务、召回、管理 API 模型、Tool schema 和 Agent 文件 I/O | 拆分 domain、application、ports、repository、recall 与 adapter | 待优化 |
| AUD-011 | P1 | 可靠性 | 主业务库与 session queue 是两个 SQLite 文件，跨库状态不能使用同一原子事务 | 定义 crash consistency 边界，补充故障注入测试，评估合库或 outbox 投影 | 待优化 |
| AUD-012 | P1 | 备份 | 当前只有一次性迁移备份，没有定时 SQLite 在线备份和恢复演练 | 每日 checkpoint + backup，保留 7/30 天，季度恢复演练 | 待优化 |
| AUD-013 | P2 | 性能 | 缺少高频群聊、2,000 消息会话、10 万日志和大附件并发基准 | 建立可重复负载脚本和 p95 延迟、RSS、数据库增长基线 | 待优化 |
| AUD-014 | P2 | 可维护性 | 多个大模块使用宽泛 `catch` 作为降级，错误分类和观测不统一 | 统一错误码、结构日志和降级计数，避免静默吞掉非预期异常 | 待优化 |
| AUD-015 | P2 | 运行时 | Node.js 24 当前仍会为内置 `node:sqlite` 输出实验性警告，后续小版本可能调整接口或行为 | 固定已验证的 Node.js 小版本，升级前运行迁移、完整性、性能和回归测试，并保留切换稳定 SQLite 驱动的预案 | 待优化 |
| AUD-016 | P1 | 协议 | session event、tool completion 和 outbox payload 私藏在 Runtime 内，无 `schemaVersion` 和统一 codec，恢复时依赖强转 | 建立 versioned contract、运行时校验、未知版本隔离与前向迁移 | 待优化 |
| AUD-017 | P1 | 耦合 | `src/openaiProvider.ts` 1,542 行，混合模型 transport、工具 dispatch、图片、重试、SSE/JWT 和日志；工具元数据与真实执行器还有两套注册源 | Provider 只实现 ModelGateway；建立单一 ToolRegistry/ToolExecutor | 待优化 |
| AUD-018 | P1 | 耦合 | `src/server.ts` 968 行，单个组合函数注册 41 条路由并管理实例、鉴权、媒体、OneBot 和错误映射 | Composition Root 只装配，路由按领域拆 Fastify plugin 并声明 request/response schema | 待优化 |
| AUD-019 | P1 | 架构 | OneBot delegate 把具体 Gateway 传进业务层，全局 DataStore 又横跨多个领域 | 使用 InboundMessage、MessagingPort 和 bounded-context repository port，禁止 domain 引用 adapter | 待优化 |
| AUD-020 | P1 | 性能 | SessionCoordinator 会 claim 到队列为空，内存 actor 实际并发更低；大积压会创建无界内存项和续租 timer | 只按可用槽位 bounded prefetch，暴露 backlog、oldest-age、running 和续租 QPS | 待优化 |
| AUD-021 | P1 | 性能 | 附件 chunks 在主线程同步全量读取后才筛选，OneBot 单帧上限 384 MiB 且缺少入口背压 | SQL top-K/FTS 或 worker 查询；缩小帧上限并增加有界 intake | 待优化 |
| AUD-022 | P1 | 部署 | Core 与 NapCat 的组件边界需要在 macOS、WSL2 和 Linux 保持一致，旧组合镜像会把网络、媒体和生命周期重新耦合 | NapCat 固定为独立 Docker 组件；Core Native/Docker 共用统一 launcher、专用 OneBot listener、token 与内联媒体契约 | 改造中 |
| AUD-023 | P1 | 数据边界 | workspace 混合业务数据、秘密、NapCat 状态、缓存、临时和开发产物；同步脚本接近整目录打包 | 按 business/runtime/secrets/cache/backups 分层并使用分级快照 | 待优化 |
| AUD-024 | P1 | 运行时 | 多处以 `process.cwd()` 推导代码根和数据根；审计时 Windows 与 WSL 还同时存在 8787 listener | 代码根用安装前缀解析，数据根只用 `SUNABOT_WORKSPACE`；增加 runtime doctor 和 split-brain 门禁 | 待优化 |
| AUD-025 | P1 | CI | `package.json` 要求 Node 24，但 GitHub Actions 使用 Node 22 | CI、Native 和 Docker 固定同一已验证 Node 24 小版本 | 待优化 |
| AUD-026 | P2 | 可维护性 | 目录缺少架构依赖门禁，14 个运维/迁移/同步脚本平铺，Codex Web Coding 脚手架没有独立边界 | 增加 architecture test；按 tooling/codex、runtime、workspace、migration、quality 分类 | 待优化 |
| AUD-027 | P2 | 供应链 | Node/NapCat 镜像只锁 tag，非 npm 组件没有统一 digest、checksum、license、architecture 和 SBOM 清单 | 建立 component lock 和升级/许可证门禁 | 待优化 |
| AUD-028 | P2 | 前端性能 | 会话页固定轮询，记忆页全量加载、过滤和渲染 | cursor/SSE、single-flight、服务端分页/搜索与虚拟列表 | 待优化 |

## 优化顺序

第一阶段处理 Linux Bash 隔离、日志保留、SQLite 备份和故障注入，这些问题直接影响迁移后的安全与数据可靠性。

第二阶段处理请求日志 FTS、消息增量表和记忆索引，目标是 10 万日志与 2,000 消息会话下管理 API p95 小于 200 ms，消息持久化 p95 小于 20 ms。

第三阶段先固化 versioned contracts、ToolRegistry 和 architecture gate，再拆分运行时、记忆、Provider、HTTP 路由和附件内部组件，避免目录调整改变回复行为。

第四阶段把 Native Core 与 Docker Core 收敛到同一 runtime contract：NapCat 保持独立 Docker 组件，统一 launcher、doctor、OneBot token、媒体边界和 workspace 分层，再按迁移备忘录切换旧服务端。

目标结构、模块协议、双运行模型和完整验收门槛见 `docs/architecture/project-structure-plan.md`。
