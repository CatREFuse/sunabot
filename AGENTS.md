# sunabot Agent 工作指南

## 唯一规范

开始修改前读取 `docs/specs/index.md`，再按索引读取与修改范围对应的模块。该索引及其模块是当前业务逻辑、数据边界和功能—代码文件索引的唯一规范。旧设计和实施计划只存在于 Git 历史，不得按历史方案恢复 JSON/JSONL 持久化。

## 用户授权

- 用户在当前任务中明确回复“授权一切操作”时，可继续执行本轮已经披露范围内的测试、外部 Provider 夹具、提交、push、重启与状态核验，不再重复询问相同操作。
- 授权只适用于当前对话已经列明的数据类别、外部目标和操作，不得延伸到未来任务、未披露数据、其他外部系统或扩大后的任务范围；本文件中的规则本身不构成新的数据外发授权。

## Docs 文档索引

| 文档 | 内容 | 读取时机 |
| --- | --- | --- |
| `docs/specs/index.md` | 当前系统规范入口与模块索引 | 任何代码或配置修改前必读，并继续读取对应模块 |
| `docs/todo.md` | TODO-driven 架构整理、性能治理、分离运行时交付任务、依赖与完成证据 | 规划迭代、选择任务、确认依赖或验收进度时读取 |
| `docs/audits/2026-07-11-codebase-audit.md` | 历史基线、原始问题编号、风险和当时的优化顺序 | 对照旧问题来源或比较历史实现时读取 |
| `docs/audits/2026-07-14-business-flow-audit.md` | 异步投递、媒体历史、首次运行、迁移门禁、账号调和与 readiness 的问题、修复结果和验收边界 | 修改 outbox、Provider 工具循环、首次接入、迁移或运行检查前读取 |
| `docs/audits/2026-07-23-llm-token-cache-audit.md` | 全部 LLM/图像节点的请求级 Token、缓存率、Prefix 复算、失败盲区与分层改进方案 | 调整模型路由、提示词缓存、上下文预算、记忆/编排/Tone 流程或模型调用统计前读取 |
| `docs/audits/2026-07-23-llm-token-cache-audit.html` | LLM Token 与 Prompt Cache 审计的自包含交互式 HTML 报告 | 浏览审计结论、图表、完整节点清单、改进优先级和验收路线图时读取 |
| `docs/audits/2026-07-24-memory-system-topology-and-logs-audit.md` | 工作记忆、长期记忆、用户画像、召回、Dream、调度器与操作日志的运行证据和高问题节点 | 排查记忆不更新、积压、模型门禁、Dream 失败或记忆操作历史前读取 |
| `docs/design/settings-information-architecture.md` | 管理台设置的信息层级、Provider 类型、字段归属与交互约束 | 调整设置页、Provider 配置或账号操作前读取 |
| `docs/design/multi-agent-information-architecture.md` | 多 Agent、多 QQ、管理台导航、Agent 工作区与统计口径 | 新增 Agent、调整 Agent 切换、多 QQ 接入或按 Agent 隔离数据前读取 |
| `docs/design/conversation-artifact-capabilities.md` | 会话文件、图片、Workbench、Codex 输入输出的统一产物句柄、能力上下文与分阶段迁移 | 调整附件获取、聊天媒体、Workbench 路由、Codex 产物或文件外发前读取 |
| `docs/design/webfetch.md` | WebFetch 的公开工具契约、静态与动态网页抓取、相关内容筛选、出站安全和实施验收计划 | 新增或修改 WebFetch、动态渲染服务、网页正文抽取或联网工具安全边界前读取 |
| `docs/architecture/project-structure-plan.md` | 目标项目结构、模块边界、组件通信、数据分层、Core Native/Docker 模型和迁移顺序 | 调整目录、拆分模块、设计协议或修改运行打包前读取 |
| `docs/migrations/wsl2-migration-plan.md` | Windows 11、Windows Server、WSL2、Docker、打包、部署、验收和回滚方案 | 迁移、打包或调整跨平台部署时读取 |
| `docs/migrations/one-container-to-split-runtime.md` | 现有单容器服务端拉取新代码后的停服、备份、切换、验证和回滚备忘录 | 旧服务端首次升级到 NapCat 独立容器前必读 |
| `docs/migrations/single-agent-to-multi-agent.md` | 单 Agent 工作区迁移到 Plana、primary 和多 Agent 注册结构的预检、备份、执行、验收与回滚 | 首次启用多 Agent、多 QQ 前必读 |
| `docs/migrations/upgrade-0.1.2-to-0.1.3.md` | 0.1.2 到 0.1.3 的聊天媒体工具、提示词保留式迁移、恢复点、验证与回滚 | 既有服务升级到 0.1.3 前必读 |
| `docs/migrations/upgrade-0.1.3-to-0.1.4.md` | 0.1.3 到 0.1.4 的图片任务可靠性、编排器上下文隔离、恢复点、验证与回滚 | 既有服务升级到 0.1.4 前必读 |
| `docs/migrations/upgrade-0.1.4-to-0.2.0.md` | 0.1.4 到 0.2.0 的跨平台 WebFetch Renderer、恢复点、验证与回滚 | 既有服务升级到 0.2.0 前必读 |
| `docs/migrations/upgrade-old-versions-to-current.md` | 0.1.0—0.2.0 老实例逐级升级到当前 revision 的总路径、双 Workbench 资源验收与回滚 | 老实例跨多个版本升级或接入当前双 Workbench 资源寻址前必读 |
| `docs/migrations/agent-workbenches.md` | Agent 双 workbench、Native 只读投影、资源迁移、验证与回滚 | 调整 Bot 文件自由度、资源投影或执行资源迁移前必读 |
| `docs/migrations/upgrade-0.1.0-to-0.1.2.md` | 0.1.0 / 0.1.1 到 0.1.2 的双工作区迁移、恢复点、升级脚本、验收与回滚 | 现有 0.1.0 或 0.1.1 实例升级到 0.1.2 前必读 |
| `docs/setup-napcat.md` | sunabot、NapCat、WebUI 和 OneBot 反向 WebSocket 的本机启动配置 | 部署、重启或排查 OneBot 连接时读取 |
| `docs/security/admin-access.md` | 管理员账号密码、会话、CSRF、限流、熔断与公网代理边界 | 修改鉴权、WebUI 外网访问或紧急处置时读取 |
| `docs/deployment/distributed-workspace.md` | Git pull、新终端、workspace 分离、主实例切换、离线备份与 Agent 配置文件夹复制边界 | 多终端开发、更新、接管 workspace 或迁移单个 Agent 时读取 |
| `docs/deployment/online-voice-synthesis.md` | 在线语音协议、Provider 配置、音色 ID、安全边界与真实 QQ 外发流程 | 配置、迁移或验收在线语音合成前读取 |
| `docs/operations/sqlite-backup-recovery.md` | 默认 Plana 与全部 Agent 业务库/queue 数据库对的一致恢复点、7/30 天保留、恢复校验、季度演练和故障门禁 | 执行每日备份、恢复、保留清理或故障演练时读取 |
| `docs/references/README.md` | OneBot v11、v12 协议资料的来源、版本和本地入口 | 核对 OneBot 事件、消息段、动作或兼容性时读取 |
| `docs/user-tests/README.md` | user test harness、用例文档、隔离 workspace、质量评审与上线门禁 | 开发任何功能、编写 user test case 或执行上线前验证时读取 |
| `docs/user-tests/workbench-image-reference.md` | workbench 图片相对路径直接进入生图工具的用户用例 | 修改 workbench 图片参数或生图参考解析时读取 |
| `docs/user-tests/workbench-image-native-absolute-reference.md` | Native workbench 真实绝对路径直接进入生图工具的用户用例 | 修改 Native workbench 绝对路径参数解析时读取 |
| `docs/user-tests/workbench-image-docker-absolute-reference.md` | Docker `/workbench` 绝对路径直接进入生图工具的用户用例 | 修改 Docker workbench 绝对路径参数解析时读取 |
| `docs/user-tests/dual-workbench-resource-addressing.md` | 管理台聚合寻址 Native 与 Docker 的表情、自拍参考图和知识资料 | 修改双 Workbench 资源管理与来源路由时读取 |
| `docs/user-tests/sent-image-reuse-send.md` | Bot 发送 workbench 图片并持久化可复用历史的链式首步用例 | 修改 `send_file` 图片历史投影时读取 |
| `docs/user-tests/sent-image-reuse.md` | 精确引用 Bot 上一轮已发图片再次生图的链式次步用例 | 修改 assistant 图片句柄或历史生图参考时读取 |
| `docs/user-tests/sent-emoji-reuse-send.md` | Bot 发送自身图库表情并持久化可复用媒体的链式首步用例 | 修改表情投递后的会话媒体投影时读取 |
| `docs/user-tests/sent-emoji-reuse.md` | 精确引用 Bot 上一轮已发表情再次生图的链式次步用例 | 修改表情历史句柄或表情参考生图时读取 |
| `docs/user-tests/orchestrator-internal-history-seed.md` | 生成用户不可见的群聊编排器内部审计记录的链式首步用例 | 修改编排器内部记录或群聊模型历史过滤时读取 |
| `docs/user-tests/orchestrator-internal-history-reply.md` | 验证内部编排器记录不进入后续主回复上下文的链式次步用例 | 修改群聊上下文、编排器变量或内部消息可见性时读取 |
| `docs/user-tests/group-topic-internal-reasoning.md` | 验证群聊主 Agent 在内部完成当前话题判断且不暴露判断过程 | 修改群聊话题判断、主回复上下文或旧实现清理边界时读取 |
| `docs/user-tests/conversation-message-32-private.md` | 验证单聊默认提示词只接收最近 32 条历史消息 | 修改单聊上下文窗口、对话提示词变量或默认上下文数量时读取 |
| `docs/user-tests/conversation-message-32-group.md` | 验证群聊默认提示词只接收最近 32 条原序历史消息 | 修改群聊上下文窗口、群聊提示词变量或默认上下文数量时读取 |
| `docs/user-tests/current-message-image-reference.md` | 当前群消息图片以精确媒体句柄进入异步生图的用户用例 | 修改当前图片句柄、dispatch 快照或参考图解析时读取 |
| `docs/user-tests/current-message-image-4k-retry-budget.md` | 当前私聊图片在预处理后以完整回复重试预算进入 4K 异步生图的用户用例 | 修改图片预处理、普通回复超时或 4K 生图派发时读取 |
| `docs/user-tests/qq-private-pdf-attachment.md` | 副账号 QQ 私聊 PDF 经账号定向下载、解析并进入主回复的用户用例 | 修改 QQ 文件查询、附件源 fallback、PDF 解析或多账号附件路由时读取 |
| `docs/user-tests/parse-failed-attachment-export.md` | QQ 文件获取成功但解析失败后仍可导出原件的用户用例 | 修改附件获取/解析状态或聊天媒体导出前读取 |
| `docs/user-tests/user-private-attachment-docker-workbench.md` | 普通 QQ 私聊文件统一导出到 Docker Workbench 并回传的用户用例 | 修改会话 Workbench 路由、聊天媒体导出或文件回传前读取 |
| `docs/user-tests/codex-chat-artifact-roundtrip.md` | 聊天文件句柄冻结为 Codex 输入并将产物回传原会话的用户用例 | 修改 Codex 异步输入、产物校验或会话资产回传前读取 |
| `docs/user-tests/selfie-direct-delivery.md` | 阿罗娜单人自拍由异步图片任务直接回传的用户用例 | 修改自拍工具派发、完成回调或媒体发送时读取 |
| `docs/user-tests/selfie-knowledge-reference-direct-delivery.md` | 阿罗娜使用知识库普拉娜参考图生成双人自拍并直接回传的用户用例 | 修改自拍知识参考、Workbench 路径快照或异步媒体发送时读取 |
| `docs/user-tests/address-name-priority.md` | 多称呼用户画像在主回复中优先使用第一个称呼的用户用例 | 修改称呼数组、用户画像提示上下文或回复称呼规则时读取 |
| `docs/user-tests/add-workmemory-direct-write.md` | 主对话模型同轮调用 `add_workmemory` 直写短期工作记忆的用户用例 | 修改工作记忆工具、主回复工具调用规则或直写审计前读取 |
| `docs/user-tests/sampled-memory-compression.md` | 运行中测试账号 V2 样本的内容无关记忆压缩模板 | 从只读样本派生真实数据记忆压缩 case 时读取 |
| `docs/user-tests/sampled-dream.md` | 运行中测试账号 V2 样本的内容无关 Dream 模板 | 从只读样本派生真实数据 Dream case 时读取 |
| `docs/user-tests/cases/memory-system/10-memory-provider-long-response.md` | 记忆 Provider 跨过旧 120 秒边界并受 10 分钟总预算约束 | 修改记忆模型超时、传输重试或异步 Provider 预算时读取 |
| `docs/user-tests/cases/memory-system/11-memory-fifo-quiet-tail.md` | 记忆队列 FIFO、失败队首重试与静默尾批处理 | 修改记忆阈值、队列顺序、重试或尾批唤醒时读取 |
| `docs/user-tests/cases/admin-console/web-chat-deadline-cancellation.md` | Web Chat 十分钟硬截止、客户端断开与服务关闭取消 | 修改 Web Chat 回复期限、请求取消或关闭生命周期时读取 |

新增、移动、重命名或删除 `docs/` 下的有效文档时，必须同步更新本索引。历史方案不进入当前索引。

## 全局 TODO

| 优先级 | 当前开放工作 |
| --- | --- |
| P1 | `DEPLOY-FIX-005` 真实 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 双 QQ 首次运行、账号定向外发和重启恢复验收 |

任务状态、实施方法和验收证据统一维护在 `docs/todo.md`；业务影响与故障复现见 `docs/audits/2026-07-14-business-flow-audit.md`。

## 索引入口

| 任务 | 先读 |
| --- | --- |
| OneBot、消息解析、回复、群聊编排 | `adapters/onebot/onebotGateway.ts`, `src/runtime.ts`, `services/orchestration/groupReplyPolicy.ts` |
| 会话顺序、异步任务、outbox、断线恢复 | `services/sessions/` |
| 记忆、用户画像、长期记忆、压缩 | `services/memory/`, `adapters/sqlite/applicationDataStore.ts` |
| 知识库、BM25、资料管理 | `services/knowledge/`, `services/tools/knowledgeSearchTool.ts`, `apps/api/plugins/knowledgeRoutes.ts`, `apps/admin-web/src/views/KnowledgeView.vue` |
| 请求日志、会话记录、图片历史 | `adapters/observability/requestLog.ts`, `adapters/sqlite/applicationDataStore.ts`, `adapters/sqlite/modelCallStore.ts`, `apps/api/plugins/conversationRoutes.ts`, `apps/api/plugins/mediaRoutes.ts` |
| 文件读取、PDF、Office、附件缓存 | `services/media/attachments/` |
| Provider、工具调用、Codex、联网搜索 | `adapters/model/openaiProvider.ts`, `services/tools/`, `adapters/codex/codexTool.ts`, `adapters/model/webSearchTool.ts` |
| 人格和最终提示词 | `services/agent/` |
| 管理 API、设置和 Agent 文件 | `apps/api/plugins/`, `apps/api/server.ts`, `src/admin/` |
| 管理台页面 | `apps/admin-web/src/views/`, `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| 数据升级与部署 | `packages/platform/multiAgentMigrationGate.mjs`, `tooling/migrations/`, `deploy/`, `docs/migrations/` |

完整映射见 `docs/specs/07-code-map.md`；规范模块入口见 `docs/specs/index.md`。

## 持久化规则

- 增长型业务数据必须写入 SQLite；唯一例外是每个 Agent 最多 64 个 key、每个 key 最多 20 个版本的有界表情目录清单 `emojis.jsonl`，它必须与内容寻址 PNG 同目录、整文件原子替换。
- 默认 Plana 的注册/业务主库是 `workspace/business/data/sunabot.sqlite`，会话执行队列是 `workspace/business/data/session-queue.sqlite`。
- 其他 Agent 的业务主库与队列分别是 `workspace/business/agents/<agentId>/data/sunabot.sqlite` 和 `workspace/business/agents/<agentId>/data/session-queue.sqlite`；附件分块是缓存项内的 `chunks.sqlite`。
- 禁止新增会话、消息、记忆、调度队列、请求日志或历史索引的 JSON/JSONL 持久化。
- JSONL 只允许用于 Codex 子进程协议、人工知识资料，以及上述有界表情目录清单，不能扩展为会话、消息、记忆、调度、请求日志或历史索引的持久化引擎。
- 配置、人格、提示词、单项 manifest 和可重建小缓存可以继续使用 JSON 或 Markdown。
- 每个向 Bot 暴露的配置或资源目录必须有且只有一个固定管理入口；当前固定为 workbench `index.md`、Skill `index.json`、MCP `servers.json`、自拍 `references.jsonl`、表情 `emojis.jsonl`、知识库 `index.json`。新增目录时必须同时定义入口文件、更新方式、权限和损坏处理。
- 任何 schema 变更必须向前迁移，不能依赖删除数据库重建。

## 修改边界

- 只修改请求涉及的模块，保持现有接口和代码风格。
- 未经用户明确要求，禁止新增会改变正常业务流程的安全门禁、工具互斥、整轮污染标记、隐式降级、额外审批或失败关闭策略。设计阶段发现风险时，只说明风险、影响和可选方案，并询问用户是否需要；用户明确确认前，不得把建议写成代码、提示词、测试或强制规范。
- Agent 工具循环默认允许同一 Provider turn 的不同模型轮次依次组合全部已启用且当前会话有权使用的工具，也允许模型响应正文与工具调用并存。不得仅依据“本地/联网”、工具名称、MCP server、先前工具活动、先前失败或 deferred/`no_reply`/语音的出现顺序拒绝后续调用。
- 已由用户明确要求或现行规范确定的身份鉴权、会话权限、参数 schema、路径边界、执行隔离、持久化事务和外部系统审批继续保留。若协议结构确实无法支持某种组合，必须在设计阶段说明具体技术限制并取得用户选择，不能包装成安全策略自行实施。
- 人格或提示词新增运行时上下文时，必须先注册为管理台可感知、可编辑的提示词变量，并由默认模板显式引用；运行时只提供经过边界校验与安全序列化的动态数据，不得在渲染后强制插入、删除、去重或重排管理员模板。升级兼容通过一次性持久模板迁移完成，不能把长期模板管理逻辑硬编码进回复编排层。
- `src/runtime.ts` 是编排层；新增独立能力优先放入明确模块，由运行时组合。
- 数据库写入必须参数化，跨来源更新必须使用事务。
- 不把明文 key、token、密码、QQ 登录缓存、请求日志、数据库、生成图片或备份加入 Git。
- `workspace/` 是终端私有数据边界，业务代码不得要求 Git 跟踪其中的任何文件。
- 用户可见文案只保留名称、状态、动作和结果，不写设计解释或实现说明。

## 跨运行环境

- NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器；Sunabot Core 允许 Native 或 Docker。禁止把 NapCat 重新并入 Core 镜像、Core 容器或 Native 进程管理单元。
- 根目录 `./sunabot.sh` 是唯一人工运行入口，支持 `up|start|down|restart|status|logs|doctor`；`up`、`start` 与 `restart` 使用同一套清空后启动流程。`SUNABOT_CORE_MODE=auto|native|docker` 只选择 Core 形态，不能改变 NapCat 的容器边界。
- 启动与迁移必须由拥有仓库和 workspace 的非 root 用户执行；不得通过 UID 0 绕过 Core、NapCat 或 workspace 权限边界。
- 管理台只监听宿主回环 `127.0.0.1:8787`。OneBot v11 使用专用的 `8788` 端口和强制 access token；Core Docker 通过 Compose 私有网络接入，Core Native 通过启动器配置的宿主网关接入。不得把 OneBot 端口直接发布到局域网或公网。
- 跨组件媒体默认使用 OneBot `base64://` 内联数据。业务代码、Core 与 NapCat 不能依赖共享绝对路径、相同挂载点或容器内文件路径；大文件能力必须新增明确、鉴权、可限流的传输契约。
- 业务模块、SQLite schema、workspace 目录和消息语义必须同时兼容 macOS Native Core、WSL/Linux Native Core 与 Docker Core；从开发环境迁移到生产环境时不能修改业务代码或业务数据格式。
- 平台差异只能放在 `apps/*` 组合根、`tooling/runtime/`、`deploy/` 或明确的平台 adapter 中，禁止在 services、领域模型和持久化模块中散布平台判断。
- macOS Native Core 仅允许管理员 QQ 私聊和已认证管理员 Web Chat 在每条命令通过独立对抗审批后使用宿主 `/bin/bash`；管理员群聊、其他群聊与其他私聊固定使用 Docker Bash，管理员 QQ 私聊和管理员 Web Chat 也可显式使用 Docker Bash。Linux/WSL Native Core 与 Docker Core 的 bubblewrap 强隔离契约不得放宽。
- 新功能涉及文件、进程、路径、附件、图片、工具、OneBot 或部署时，必须验证 Native Core + NapCat Docker 与 Docker Core + NapCat Docker 的组件边界；至少运行 `npm run runtime:contract`、相关单元测试、`npm run check` 与 `npm run build`。
- 平台专属依赖缺失时，启动器或 doctor 必须返回明确状态；不得静默切换运行模式，不得同时运行旧单容器和新分离运行时，也不得改变数据库、配置或 workspace 的跨平台格式。
- 服务端拉取代码后若发现旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service，必须在首次执行 `./sunabot.sh up` 前完整执行 `docs/migrations/one-container-to-split-runtime.md`；不得删除旧容器、跳过离线双库备份或边运行边迁移。

## 验证

### User test harness

- 所有功能在开发前必须先写 user test case Markdown，完整描述用户目标、角色/环境、输入、预期工具与输出、质量标准。主对话角色必须明确为管理员私聊、非管理员私聊、管理员群聊或非管理员群聊之一。
- 默认验证顺序为：受影响单元测试 → user test harness → 其他集成、安全、迁移、runtime、构建、E2E、视觉与跨平台测试。任一阶段失败都不能上线，必须由主 Agent 汇总证据并返工。
- harness 优先交给 subagent 执行，可使用 `terra` 等次旗舰模型。尽可能让多个 fixture Agent 并行测试；核心流程或复杂功能的同一个 case 可以交给多个 fixture Agent 独立复测。
- fixture Agent 只运行夹具、查验机械断言与输出质量、写报告，不分析或修改产品代码。具体根因、修复方案、代码改动和复测收口由主 Agent 完成。
- 主对话夹具必须从原始 OneBot event 进入 production ingress，并使用隔离 workspace、mock MessagingPort 和真实 Session/Provider/tool/outbox 链。`actor` 是 case 声明的可移植角色，run 只在进程内把事件用户投影为管理员或非管理员，不能依赖源 workspace 的真实管理员 QQ，也不能写回配置。不得直接调用 reply 方法后声称覆盖真实入站。
- 主对话前置数据必须写入 case 的 `input.fixture`，由 harness 在 raw OneBot ingress 前机械 seed 隔离工作记忆、长期记忆、用户画像、AIR 或 Native/Docker Workbench 文件；不能只在 Markdown 段落中要求 fixture Agent 手工猜测或准备。静默、媒体等 case 使用 outbound kind 断言区分 `message`、`asset` 与 `poke`。
- 每个独立 run 及网络/权限重试必须重新 prepare 全新隔离 workspace；相同 OneBot event 不得在同一 workspace 重跑并复用旧 Session/outbox。只有 case 文档明确声明的状态链式套件可以按不同 case 和不同 message ID 顺序复用一个 workspace。
- macOS Colima 的 Docker Bash case 必须把隔离 workspace 放在 VM 可挂载的宿主共享路径，例如仓库内已忽略的 `.user-test-runs/workspaces/`；不得把 `/private/tmp` 的 bind-mount 失败归因于产品。
- Dream、记忆压缩等分支夹具直接调用对应业务管线并把输入与持久化定向到临时 workspace。工作记忆、长期记忆、用户画像、会话及 Dream 的人格、任务、Director 日程必须在 case 中显式声明；live branch case 必须声明逻辑 `now` 与 `timePolicy: "rebase_to_runtime"`，所有结构化事件时间按同一偏移平移，Director 日程按目标 Dream 日期保留本地时刻重映射，报告保留不含正文的 timeline 证据。不得隐式继承源账号记忆。可以从正在运行的测试账号只读取样，但必须使用只读 SQLite 生成不可逆脱敏、时间平移的 V2 快照，先由 fixture Agent 人工复核自由文本，再通过 `derive-branch-case` 注入预先写好的 case；禁止在真实测试账号 workspace 上构造 Runtime、执行 migration、初始化 recall tracking 或写回数据。
- harness 报告必须同时包含机械断言和质量评审。工具是否调用、参数/结果、分支状态、持久化 diff、outbox 属于机械证据；准确性、完整性、可用性、语气、是否虚构属于质量证据。缺少独立质量评审的 run 保持 `inconclusive`，不能上线。
- required tool 只有在对应 `tool.call` 结果成功时才算通过；失败、仅排队或只出现在 Provider tool catalog 中都不能计为成功。动态 MCP tool 也必须保留调用与结果证据。
- `runtime:release` 前必须使用 `.user-test-runs/release-manifest.json` 通过 release gate；清单必须覆盖本次功能的全部 case，并绑定当前 Git revision、当前 case digest、独立 run 与 reviewer。复杂核心 case 在清单中提高 `minimumIndependentRuns`，不得复用同一 run 或 reviewer 冒充并行复测。
- 用法、case 模板、review/gate 命令与覆盖边界见 `docs/user-tests/README.md`。harness 不能替代协议拒绝、安全故障注入、迁移恢复、并发幂等、视觉、跨平台或真实 NapCat/QQ 验收。

基础验证：

```bash
npm run verify
```

界面变更还需运行 `npm run test:visual` 并检查截图。数据迁移必须在服务停止后执行对应的 `npm run migrate:sqlite` 或 `npm run migrate:multi-agent` 流程，确认恢复点、记录数校验、SQLite checkpoint 和重启后的 API 状态。
