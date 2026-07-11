# sunabot Agent 工作指南

## 唯一规范

开始修改前读取 `docs/specs/current-system-spec.md`。该文件是当前业务逻辑、数据边界和功能—代码文件索引的唯一规范。旧设计和实施计划只存在于 Git 历史，不得按历史方案恢复 JSON/JSONL 持久化。

## Docs 文档索引

| 文档 | 内容 | 读取时机 |
| --- | --- | --- |
| `docs/specs/current-system-spec.md` | 当前产品范围、业务规则、数据边界、持久化结构、功能—代码文件索引和验证标准 | 任何代码或配置修改前必读 |
| `docs/todo.md` | TODO-driven 架构整理、性能治理、Native/单容器交付任务、依赖与完成证据 | 规划迭代、选择任务、确认依赖或验收进度时读取 |
| `docs/audits/2026-07-11-codebase-audit.md` | 已验证基线、问题编号、风险、优先级和优化顺序 | 修复缺陷、性能优化、解耦或可靠性改造前读取 |
| `docs/architecture/project-structure-plan.md` | 目标项目结构、模块边界、固定协议、数据分层、Native/单容器模型和迁移顺序 | 调整目录、拆分模块、设计协议或修改运行打包前读取 |
| `docs/migrations/wsl2-migration-plan.md` | Windows 11、Windows Server、WSL2、Docker、打包、部署、验收和回滚方案 | 迁移、打包或调整跨平台部署时读取 |
| `docs/setup-napcat.md` | sunabot、NapCat、WebUI 和 OneBot 反向 WebSocket 的本机启动配置 | 部署、重启或排查 OneBot 连接时读取 |
| `docs/security/admin-access.md` | 管理员账号密码、会话、CSRF、限流、熔断与公网代理边界 | 修改鉴权、WebUI 外网访问或紧急处置时读取 |
| `docs/deployment/distributed-workspace.md` | Git pull、新终端、workspace 分离与百度同步盘加密快照 | 多终端开发、更新或数据同步时读取 |
| `docs/references/README.md` | OneBot v11、v12 协议资料的来源、版本和本地入口 | 核对 OneBot 事件、消息段、动作或兼容性时读取 |

新增、移动、重命名或删除 `docs/` 下的有效文档时，必须同步更新本索引。历史方案不进入当前索引。

## 索引入口

| 任务 | 先读 |
| --- | --- |
| OneBot、消息解析、回复、群聊编排 | `adapters/onebot/onebotGateway.ts`, `src/runtime.ts`, `services/orchestration/groupReplyPolicy.ts` |
| 会话顺序、异步任务、outbox、断线恢复 | `services/sessions/` |
| 记忆、用户画像、长期记忆、压缩 | `services/memory/`, `src/dataStore.ts` |
| 请求日志、会话记录、图片历史 | `src/dataStore.ts`, `src/requestLog.ts`, `src/server.ts` |
| 文件读取、PDF、Office、附件缓存 | `services/media/attachments/` |
| Provider、工具调用、Codex、联网搜索 | `adapters/model/openaiProvider.ts`, `services/tools/`, `adapters/codex/codexTool.ts`, `adapters/model/webSearchTool.ts` |
| 人格和最终提示词 | `services/agent/` |
| 管理 API、设置和 Agent 文件 | `src/server.ts`, `src/admin/` |
| 管理台页面 | `apps/admin-web/src/views/`, `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| 数据升级与部署 | `tooling/migrations/migrate-to-sqlite.mjs`, `deploy/`, `docs/migrations/wsl2-migration-plan.md` |

完整映射见 `docs/specs/current-system-spec.md` 的“功能—代码文件索引”。

## 持久化规则

- 增长型业务数据必须写入 SQLite。
- 主库是 `workspace/artifacts/sunabot.sqlite`；会话执行队列是 `workspace/artifacts/session-queue.sqlite`；附件分块是缓存项内的 `chunks.sqlite`。
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

## 验证

基础验证：

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

界面变更还需运行 `npm run test:visual` 并检查截图。数据迁移必须在服务停止后执行 `npm run migrate:sqlite`，确认备份、记录数校验、SQLite checkpoint 和重启后的 API 状态。
