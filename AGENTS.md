# sunabot Agent 工作指南

## 唯一规范

开始修改前读取 `docs/specs/current-system-spec.md`。该文件是当前业务逻辑、数据边界和功能—代码文件索引的唯一规范。旧设计和实施计划只存在于 Git 历史，不得按历史方案恢复 JSON/JSONL 持久化。

## Docs 文档索引

| 文档 | 内容 | 读取时机 |
| --- | --- | --- |
| `docs/specs/current-system-spec.md` | 当前产品范围、业务规则、数据边界、持久化结构、功能—代码文件索引和验证标准 | 任何代码或配置修改前必读 |
| `docs/todo.md` | TODO-driven 架构整理、性能治理、分离运行时交付任务、依赖与完成证据 | 规划迭代、选择任务、确认依赖或验收进度时读取 |
| `docs/audits/2026-07-11-codebase-audit.md` | 已验证基线、问题编号、风险、优先级和优化顺序 | 修复缺陷、性能优化、解耦或可靠性改造前读取 |
| `docs/design/settings-information-architecture.md` | 管理台设置的信息层级、Provider 类型、字段归属与交互约束 | 调整设置页、Provider 配置或账号操作前读取 |
| `docs/architecture/project-structure-plan.md` | 目标项目结构、模块边界、组件通信、数据分层、Core Native/Docker 模型和迁移顺序 | 调整目录、拆分模块、设计协议或修改运行打包前读取 |
| `docs/migrations/wsl2-migration-plan.md` | Windows 11、Windows Server、WSL2、Docker、打包、部署、验收和回滚方案 | 迁移、打包或调整跨平台部署时读取 |
| `docs/migrations/one-container-to-split-runtime.md` | 现有单容器服务端拉取新代码后的停服、备份、切换、验证和回滚备忘录 | 旧服务端首次升级到 NapCat 独立容器前必读 |
| `docs/setup-napcat.md` | sunabot、NapCat、WebUI 和 OneBot 反向 WebSocket 的本机启动配置 | 部署、重启或排查 OneBot 连接时读取 |
| `docs/security/admin-access.md` | 管理员账号密码、会话、CSRF、限流、熔断与公网代理边界 | 修改鉴权、WebUI 外网访问或紧急处置时读取 |
| `docs/deployment/distributed-workspace.md` | Git pull、新终端、workspace 分离、主实例切换与离线备份边界 | 多终端开发、更新或迁移 workspace 时读取 |
| `docs/operations/sqlite-backup-recovery.md` | 主库与 session queue 一致恢复点、7/30 天保留、恢复校验、季度演练和故障门禁 | 执行每日备份、恢复、保留清理或故障演练时读取 |
| `docs/references/README.md` | OneBot v11、v12 协议资料的来源、版本和本地入口 | 核对 OneBot 事件、消息段、动作或兼容性时读取 |

新增、移动、重命名或删除 `docs/` 下的有效文档时，必须同步更新本索引。历史方案不进入当前索引。

## 索引入口

| 任务 | 先读 |
| --- | --- |
| OneBot、消息解析、回复、群聊编排 | `adapters/onebot/onebotGateway.ts`, `src/runtime.ts`, `services/orchestration/groupReplyPolicy.ts` |
| 会话顺序、异步任务、outbox、断线恢复 | `services/sessions/` |
| 记忆、用户画像、长期记忆、压缩 | `services/memory/`, `adapters/sqlite/applicationDataStore.ts` |
| 请求日志、会话记录、图片历史 | `adapters/sqlite/applicationDataStore.ts`, `src/requestLog.ts`, `apps/api/plugins/conversationRoutes.ts`, `apps/api/plugins/mediaRoutes.ts` |
| 文件读取、PDF、Office、附件缓存 | `services/media/attachments/` |
| Provider、工具调用、Codex、联网搜索 | `adapters/model/openaiProvider.ts`, `services/tools/`, `adapters/codex/codexTool.ts`, `adapters/model/webSearchTool.ts` |
| 人格和最终提示词 | `services/agent/` |
| 管理 API、设置和 Agent 文件 | `apps/api/plugins/`, `apps/api/server.ts`, `src/admin/` |
| 管理台页面 | `apps/admin-web/src/views/`, `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| 数据升级与部署 | `tooling/migrations/migrate-to-sqlite.mjs`, `deploy/`, `docs/migrations/wsl2-migration-plan.md` |

完整映射见 `docs/specs/current-system-spec.md` 的“功能—代码文件索引”。

## 持久化规则

- 增长型业务数据必须写入 SQLite。
- 主库是 `workspace/business/data/sunabot.sqlite`；会话执行队列是 `workspace/business/data/session-queue.sqlite`；附件分块是缓存项内的 `chunks.sqlite`。
- 禁止新增会话、消息、记忆、调度队列、请求日志或历史索引的 JSON/JSONL 持久化。
- Codex JSONL 仅用于子进程协议，可以保留。
- 配置、人格、提示词、单项 manifest 和可重建小缓存可以继续使用 JSON 或 Markdown。
- 任何 schema 变更必须向前迁移，不能依赖删除数据库重建。

## 修改边界

- 只修改请求涉及的模块，保持现有接口和代码风格。
- `src/runtime.ts` 是编排层；新增独立能力优先放入明确模块，由运行时组合。
- 数据库写入必须参数化，跨来源更新必须使用事务。
- 不把明文 key、token、密码、QQ 登录缓存、请求日志、数据库、生成图片或备份加入 Git。
- `workspace/` 是终端私有数据边界，业务代码不得要求 Git 跟踪其中的任何文件。
- 用户可见文案只保留名称、状态、动作和结果，不写设计解释或实现说明。

## 跨运行环境

- NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器；Sunabot Core 允许 Native 或 Docker。禁止把 NapCat 重新并入 Core 镜像、Core 容器或 Native 进程管理单元。
- 根目录 `./sunabot.sh` 是唯一人工运行入口，支持 `up|down|restart|status|logs|doctor`。`SUNABOT_CORE_MODE=auto|native|docker` 只选择 Core 形态，不能改变 NapCat 的容器边界。
- 启动与迁移必须由拥有仓库和 workspace 的非 root 用户执行；不得通过 UID 0 绕过 Core、NapCat 或 workspace 权限边界。
- 管理台只监听宿主回环 `127.0.0.1:8787`。OneBot v11 使用专用的 `8788` 端口和强制 access token；Core Docker 通过 Compose 私有网络接入，Core Native 通过启动器配置的宿主网关接入。不得把 OneBot 端口直接发布到局域网或公网。
- 跨组件媒体默认使用 OneBot `base64://` 内联数据。业务代码、Core 与 NapCat 不能依赖共享绝对路径、相同挂载点或容器内文件路径；大文件能力必须新增明确、鉴权、可限流的传输契约。
- 业务模块、SQLite schema、workspace 目录和消息语义必须同时兼容 macOS Native Core、WSL/Linux Native Core 与 Docker Core；从开发环境迁移到生产环境时不能修改业务代码或业务数据格式。
- 平台差异只能放在 `apps/*` 组合根、`tooling/runtime/`、`deploy/` 或明确的平台 adapter 中，禁止在 services、领域模型和持久化模块中散布平台判断。
- macOS Native Core 不具备 bubblewrap 时，`workspace_bash` 必须关闭或安全拒绝；Linux/WSL Native Core 与 Docker Core 的 bubblewrap 强隔离契约不得放宽。
- 新功能涉及文件、进程、路径、附件、图片、工具、OneBot 或部署时，必须验证 Native Core + NapCat Docker 与 Docker Core + NapCat Docker 的组件边界；至少运行 `npm run runtime:contract`、相关单元测试、`npm run check` 与 `npm run build`。
- 平台专属依赖缺失时，启动器或 doctor 必须返回明确状态；不得静默切换运行模式，不得同时运行旧单容器和新分离运行时，也不得改变数据库、配置或 workspace 的跨平台格式。
- 服务端拉取代码后若发现旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service，必须在首次执行 `./sunabot.sh up` 前完整执行 `docs/migrations/one-container-to-split-runtime.md`；不得删除旧容器、跳过离线双库备份或边运行边迁移。

## 验证

基础验证：

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

界面变更还需运行 `npm run test:visual` 并检查截图。数据迁移必须在服务停止后执行 `npm run migrate:sqlite`，确认备份、记录数校验、SQLite checkpoint 和重启后的 API 状态。
