# sunabot 业务流程与首次运行审计

日期：2026-07-14
范围：异步任务、outbox、OneBot 外发、图片引用与历史、Provider 工具循环、空 workspace、Agent/QQ 首次接入、迁移和运行状态检查

本审计基于当前实现、持久化状态机、故障路径测试和本轮并发会话的实际回归结果。2026-07-11 的代码库审计继续保留性能和长期架构基线；本文记录本轮确认的业务流程问题、修复结果和验收边界。

## 验证基线

| 检查 | 本轮结果 |
| --- | --- |
| 单元与集成测试 | 172 个 Vitest 文件、1,038 项测试通过 |
| Runtime smoke | 1 个独立 Vitest 文件、14 项测试通过 |
| 端到端测试 | 当前 `npm run verify` 33 项通过 |
| 视觉回归 | light/dark 共 8 项通过并完成截图检查 |
| 架构门禁 | `npm run architecture` 通过，违规 fixture 覆盖依赖边界、循环、public API、durable codec、ToolRegistry 和文件尺寸 |
| SQLite 恢复门禁 | `npm run backup:gate` 26 项通过；manifest v2 覆盖默认 Plana 与全部已登记/磁盘发现 Agent 双库，v1 保持兼容 |
| 运行与构建 | 当前完整 `npm run verify` 已通过 runtime contract、architecture、recovery gate、类型检查、测试、runtime smoke、CI benchmark、生产构建和 33 项 E2E |

## 已修复

### FLOW-FIX-001｜持久化回复门控

旧 reply、`no_reply` 戳一戳和异步结果曾可能在关闭回复后留在 outbox，开关再次启用时按新的门控状态继续外发。当前 payload 持久化 `generation`、scope、conversation ID、scope epoch 和 conversation epoch，投递前再次校验回复抑制、发送者、门控快照和取消信号；旧 payload 与跨进程 generation 使用当前配置执行兼容校验。

覆盖文件：`packages/contracts/session/runtimeMessages.ts`、`services/orchestration/groupReplyPolicy.ts`、`src/runtime/delivery.ts`、`src/runtime/intake.ts`、`src/runtime/reply.ts`。回归覆盖关闭后重新启用、队列关闭/重开、正文、戳一戳和 deferred completion。

### MEDIA-FIX-001｜历史图片引用与 Agent 图片历史

会话上下文现在向模型提供稳定的 `message:<message-id>:image:<index>` 句柄，显式句柄只解析当前会话和 dispatch 捕获序列，自动历史只选择当前用户；异步图片任务持久化派发时的媒体映射，避免任务执行时会话变化导致引用漂移。生成图片 URL 仅解析 legacy 单文件或 `agents/<agentId>/<file>.png`，并拒绝路径穿越、非法 Agent ID、缺失文件和符号链接逃逸。图片历史、生成目录和管理 API 读取均按 Agent 隔离。

覆盖文件：`services/tools/generateImgTool.ts`、`services/tools/selfieTool.ts`、`src/runtime/reply.ts`、`src/runtime/replyContext.ts`、`adapters/model/provider/imageInput.ts`、`apps/api/plugins/mediaRoutes.ts`。回归覆盖精确句柄、同用户历史、dispatch 快照、Agent 生成图和越界路径。

### ONBOARD-FIX-001｜空 workspace 的人格与 Codex 授权路径

新 Plana 和新 Agent 会以 write-if-missing 方式创建六个人格文件、自拍改写和 Agent 级最终提示词，已有人工内容不会被覆盖。Codex Responses 默认从当前 `SUNABOT_WORKSPACE/secrets/codex/auth.json` 读取授权；显式绝对路径保持原义，显式相对路径按项目路径规则解析，外置 workspace 不再回落到错误的用户目录。

覆盖文件：`services/agents/agentRegistry.ts`、`adapters/model/provider/transport.ts`，以及 `agent-registry`、`provider-adapter-contracts` 回归。

### ONBOARD-FIX-002｜管理员 QQ 与多账号初始化目录

默认配置中的真实管理员 QQ 已清空，首次运行必须由部署者填写 `bot.adminQq` 后才能取得管理员工具权限。workspace 初始化只创建 `runtime/napcat/accounts/` 根目录，不再制造 `runtime/napcat/config-full`、`plugins` 和 `qq` 三个旧单账号目录；账号私有目录由注册流程按 account ID 创建。

覆盖文件：`src/config.ts`、`tooling/workspace/init-workspace.mjs`、`tests/unit/config-load.test.ts`、`tests/unit/workspace-init.test.ts`。

### ARCH-FIX-001｜架构依赖门禁清零

Agent 配置管理已移至组合/管理边界，Agent 注册服务改为注入 repository，OneBot 连接上下文进入 messaging contract，跨 service 调用使用 public API；SQLite schema 与模型调用存储从主 store 拆出，配置 revision 和回复上下文也完成拆分。当前架构门禁无失败项，文件和类尺寸回到预算内。

### RECOVERY-FIX-001｜多 Agent SQLite 恢复点 v2

恢复点 v2 以注册主库和 Agent 数据目录扫描结果的并集核对范围，覆盖启用与停用 Agent，拒绝缺库、单边库、孤儿库、非法 ID 和越界路径。manifest 按 Agent 记录业务库、queue、校验信息和投递不变量；校验与恢复由 manifest 驱动，旧 v1 恢复点仍可使用。此项完成了恢复点范围与恢复门禁，定时备份、保留策略和完整故障注入仍属于开放任务。

### ONBOARD-FIX-003｜单 Agent 迁移启动门禁

workspace 初始化、API 组合根与 AgentRegistry 现在会在任何配置、目录或 SQLite 写入前校验 `business/migrations/multi-agent-v1.json`。真正空目录先写入 `fresh-install` 标记，发布进程在创建门禁目录或临时 marker 后中断时可以安全重试；主库出现后，fresh 与 completed 状态都核对全部 Agent 的规范 workspace、manifest 和必需双库、全部 QQ 的归属、端口与运行目录，以及 Plana/primary 基线。完成标记还固定核对目标 workspace 和 primary 端口；未标记既有目录、摘要或格式无效、完整注册状态漂移和必需路径中的符号链接都会稳定拒绝，且不会补建当前目录。显式迁移会核对配置与固定端口、全部注册账号 WebUI 端口和带当前 workspace 标签的全部活动容器，随后创建并复验恢复点与迁移报告，再写入绑定恢复点 ID、恢复 manifest、报告、源状态和目标注册信息的完成标记；结构已就绪但未标记的 workspace 仍需停服并重新建立恢复点。外部主库覆盖已经退役，launcher、doctor、API 与迁移器会拒绝进程或 runtime.env 中的 `SUNABOT_DATABASE_PATH`。

覆盖文件：`packages/platform/multiAgentMigrationGate.mjs`、`tooling/workspace/init-workspace.mjs`、`tooling/migrations/migrate-single-agent-to-multi-agent.mjs`、`apps/api/server.ts`、`services/agents/agentRegistry.ts`。回归覆盖空目录、中断 marker 恢复、默认与显式配置 API 直启零写入、标记篡改、全部注册状态与目标关系漂移、符号链接穿越、外部数据库覆盖、secondary 端口、paused/restarting 容器、AgentRegistry 直接初始化、四类 copied/preserved 报告证据和现有结构显式封存。

### FLOW-FIX-002｜Web Chat 顺序与 Agent 选库

每个 Agent 现在长期复用同一个 Web Chat 服务实例，并发 HTTP 请求进入同一顺序队列，固定时钟下的消息 ID 也保持连续。`replyToIncoming` 统一进入该 Agent 的异步运行上下文，非 Plana Web Chat 的请求日志与 Token 聚合写入目标 Agent 数据库。

### FLOW-FIX-003｜多账号恢复、引用与身份路由

重启恢复的群聊输入保留 Agent 与账号字段；当前引用、历史附件、嵌套引用和发送者身份查询都携带 account ID，身份缓存与进行中请求也按账号隔离。secondary 账号不会再退化到 primary 会话或查询其他 QQ。

### ONBOARD-FIX-004｜兼容注销与 Agent 创建补偿

旧版 primary 注销接口显式定向 primary；只有 secondary 在线时请求会失败并撤销人工登录状态，不会向其他 QQ 发送 `bot_exit`。Plana 的 primary 是固定基线账号，可以退出 QQ 登录，不能从注册表移除；管理 API 返回 `PRIMARY_ACCOUNT_REQUIRED`，管理台不显示移除入口。新增 Agent 的运行时初始化失败后会补偿删除注册记录、刚创建的 workspace 和临时回滚目录。

### RELEASE-FIX-001｜Linux 发行与账号运行契约

Linux 发行归档现在同时携带预构建 Native Core、生产依赖、Docker Core 所需完整源构建上下文、迁移工具、迁移门禁和文档。发行入口要求干净 Git 工作树、固定 source commit 和重新生产构建；无 Git 发行目录中的 schema v2 manifest 绑定 runtime contract、发行版本、Node、真实 Linux/x64、source commit，以及完整 `dist/`、`tooling/`、生产 `node_modules/` 和依赖锁文件的 SHA-256，迁移 wrapper 在复算文件集合与哈希后直接复用预构建 `dist`。npm `.bin` 命令链接不进入迁移执行闭包，其他符号链接失败关闭。Linux/amd64 Node 24.18.0 的独立构建已经验证归档无 `.git`、生产依赖、迁移 dry-run、全部 Docker context 资产和 18/18 Compose/Docker 构建目标。旧 `qq:configure` 和单账号配置入口已经移除；runtime contract、workspace layout 与 runtime smoke 以 `runtime/napcat/accounts/<accountId>/` 为当前边界，旧根目录字段只保留为显式迁移源。

## 本轮修复收口

| ID | 修复结果 | 验收证据 |
| --- | --- | --- |
| FLOW-001 | outbox 按 account ID 分区，暂停、探针和恢复只作用于目标 QQ；旧 v2 `sending` 升级为 `delivery_unknown`。 | 断连、探针成功后 settle 失败、传输前失败、未知传输、跨分区 FIFO、cursor 连续终态与升级反例通过。 |
| FLOW-002 | 远端 receipt 与本地 settle 两阶段持久化；会话、日志、记忆和逐 handler hook 使用稳定幂等键，不确定副作用进入人工确认。 | 真实 SQLite 关闭、每个本地步骤失败、hook 前后崩溃、多 handler 部分成功和 `applied/not_applied` 通过，未再次调用 OneBot。 |
| MIG-001 | 旧数据按幂等键集合核对真实增量；数据库 checkpoint 后持有独占锁；恢复点覆盖主库、queue 与 chunks。 | 同计数异 ID、重复导入、活动 WAL、外置 workspace、路径越界和 restore/drill 回归通过。 |
| MIG-002 | workspace 移动先持久 intent，再 staged copy、校验与原子切换；删除前复验类型、大小和 SHA-256。 | 预存目标、未知替换、复制与 rename 边界中断、敏感恢复副本、父链符号链接和完整回滚通过。 |
| FLOW-003 | 一次 completion 共享 `TurnToolState`，五种协议统一跨轮工具顺序。 | `assistant_text → no_reply`、普通工具 → `no_reply`、`assistant_text → deferred` 拒绝；合法首轮路径保持通过。 |
| RECOVERY-001 | 通用恢复与迁移恢复均在复制前写 fsync journal，支持 per-file resume/rollback。 | intent、copy、rename 边界，未知替换，SHA-256、SQLite、表计数和 queue 不变量复验通过。 |
| ONBOARD-002 | CLI、API 与平台入口共用 schema v1 probe；Provider 区分 configured 与 verified，公开 health 只返回 liveness。 | 缺凭据、503、拒绝连接、超时、Gemini header 密钥边界、QQ 离线与状态页三态通过。 |
| ONBOARD-003 | 宿主 daemon 按账号调和 NapCat；Docker Core 使用 workspace bridge，不挂载 Docker socket。 | 新增、停用、删除、重复调和、daemon 缺失/超时持久状态和注册库不可读零容器操作通过。 |
| ONBOARD-004 | HMAC first-run journal 覆盖六个持久化边界，完整父链门禁在所有入口的首个写动作前执行。 | Cookie+CSRF、Provider HTTP、OneBot WebSocket E2E，6 个边界各 resume/rollback 的 12 次 SIGKILL，损坏 schema、缺索引、父链符号链接和未知文件保留通过。 |
| ONBOARD-005 | help 与只读命令不安装依赖；option-first 正确进入启动路径。 | `help`、`status`、`doctor`、`logs`、`down`、`bootstrap`、`--core` 和 `--dev` 回归通过。 |

真实 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 的双 QQ 登录、账号定向文字/图片/文件外发和重启恢复仍需在对应部署环境执行；受控 Provider/OneBot E2E 不替代该运行验收。
