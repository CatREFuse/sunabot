# sunabot 业务流程与首次运行审计

日期：2026-07-14
范围：异步任务、outbox、OneBot 外发、图片引用与历史、Provider 工具循环、空 workspace、Agent/QQ 首次接入、迁移和运行状态检查

本审计基于当前实现、持久化状态机、故障路径测试和本轮并发会话的实际回归结果。2026-07-11 的代码库审计继续保留性能和长期架构基线；本文记录本轮新增确认的业务流程问题、已经落地的修复和后续实施顺序。

## 验证基线

| 检查 | 本轮结果 |
| --- | --- |
| 单元与集成测试 | 165 个 Vitest 文件、910 项测试通过 |
| Runtime smoke | 1 个独立 Vitest 文件、14 项测试通过 |
| 端到端测试 | 当前 `npm run verify` 33 项通过 |
| 视觉回归 | light/dark 共 8 项通过并完成截图检查 |
| 架构门禁 | `npm run architecture` 通过，违规 fixture 覆盖依赖边界、循环、public API、durable codec、ToolRegistry 和文件尺寸 |
| SQLite 恢复门禁 | `npm run backup:gate` 17 项通过；manifest v2 覆盖默认 Plana 与全部已登记/磁盘发现 Agent 双库，v1 保持兼容 |
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

## 开放问题

### P1

| ID | 现状与影响 | 实施方法 | 验收 |
| --- | --- | --- | --- |
| FLOW-001 | 同一 Agent 共用一个 SessionCoordinator。任一 QQ 账号离线导致某条 outbox 抛出断连错误后，coordinator 会暂停整个 outbox pump，同 Agent 的其他在线 QQ 也无法继续投递。 | 为 outbox 增加稳定 `deliveryPartition`，当前 OneBot 分区使用 account ID；claim 时排除已暂停分区，断连探针和恢复状态按分区维护，成功投递只恢复对应分区。Web delivery 与未来 adapter 使用独立分区。 | 同 Agent 两个 QQ 中一个离线时，在线账号继续按序投递；离线账号不忙等，重连后只补发自身队列；不同账号互不越序，重启恢复行为一致。 |
| FLOW-002 | OneBot action 已成功后，若本地消息落库、请求日志或 `after_reply` hook 失败，当前 delivery 会向 coordinator 抛错并重试整条 outbox，可能向 QQ 重复发送。传输超时时结果未知，也会进入相同重试路径。 | 把远端发送与本地 settle 拆成两个持久阶段。收到 OneBot `message_id` 后先记录 remote receipt 和 `sent_remote` 状态，后续日志、会话投影和 hook 使用幂等 settle，失败时不能再次调用 OneBot。传输结果未知进入 `delivery_unknown`，保留人工核对和受控重放入口；只有明确未发送的失败可自动重试。 | 在远端成功后的每个本地步骤注入故障，QQ 侧始终只收到一条；重启后只继续 settle；超时未知不自动重发；receipt、日志和最终状态可追踪。 |
| MIG-001 | `migrate-to-sqlite` 的备份目标用项目根计算相对路径，外置 `SUNABOT_WORKSPACE` 可能产生 `..`；队列库、附件 chunks 和删除前的不变量校验也未形成统一 manifest 与可执行恢复流程。 | 所有备份路径以 workspace 为根，规范化后拒绝逃逸；迁移前使用 SQLite backup/checkpoint 建立带 SHA-256 manifest 的恢复点，逐来源记录导入前后数量与幂等键，校验主库、queue、每个 chunks 数据库和外键后再删除源文件，并提供对应 restore/drill fixture。 | 外置 workspace、重复执行、预存目标数据、同名附件目录、磁盘满和删除中断均可恢复；任何备份路径不能离开本次恢复点；删除前后记录数与哈希可复验。 |
| MIG-002 | workspace 布局迁移会把 `.env`、`security` 和旧 NapCat 状态排除在普通备份外，后续仍会移动或删除这些来源；当前 marker 只记录结果，没有覆盖所有移动项的源/目标哈希和完整回滚步骤。 | 停服后为敏感内容建立权限为 `0600/0700` 的离线恢复包或明确要求并验证外部备份；manifest 记录每个源、目标、类型、大小和哈希。移动采用 staged copy → 校验 → 原子切换，失败按 manifest 恢复；marker 在全部切换完成后写入。 | 对每个移动步骤注入失败都能恢复到迁移前布局；敏感内容不进入 Git/日志但有可验证恢复副本；冲突、符号链接、跨文件系统和磁盘满安全失败。 |
| ONBOARD-002 | `status` 与 `doctor` 尚未统一报告 API、OneBot listener、每个 QQ、Provider、Codex、LibreOffice、bubblewrap、workspace 和迁移状态；部分检查在 launcher 与平台脚本重复，容易产生不同结论。 | 建立单一只读 probe 模块和版本化结果结构，CLI、管理 API 与平台入口共同调用。区分 liveness、readiness 和 capability，QQ 临时离线作为账号状态，不把 Core 判为死亡；所有失败返回稳定代码、目标路径和修复动作。 | Native/Docker、端口冲突、错误 workspace、旧实例、单 QQ 离线、Provider 离线、Codex 缺授权、LibreOffice/bwrap 缺失 fixture 结果一致；`status` 与 `doctor` 不修改环境。 |
| ONBOARD-003 | 管理台新增 QQ 后需要人工重启，当前 API 只完成注册和目录创建；UI 缺少期望容器、实际容器、最近调和结果和失败原因，用户只能看到“重启后登录”。 | 增加 account runtime reconciler，由统一 launcher 契约按账号创建、启动、停止或移除 NapCat 容器；API 返回 `desiredState`、`observedState`、`reconcileRequired`、`lastError`。若本轮仍保留重启模型，必须持久化 restart-required 状态并在重启后确认清除。 | 新增账号无需重启 Core 即可进入扫码态，失败原因在管理台可见；重复调和幂等；删除/停用只影响目标账号；两个账号端口、volume 和 OneBot 身份保持隔离。 |
| ONBOARD-004 | README 已同步当前依赖与首次运行顺序，但尚无从真正空目录完成 workspace 初始化、管理员设置、Provider 选择、Agent 创建、QQ 扫码前状态和首次回复的端到端门禁。当前只验证 marker 目录与临时文件中断可重试；主库出现后若队列库、manifest 或账号状态未完成，门禁会安全拒绝，但没有自动续跑或回滚。 | 建立临时外置 workspace 的 first-run E2E，使用受控 Provider/OneBot fixture 覆盖初始化、首次管理员、明确选择默认 Provider、创建 Agent/QQ、重启或调和、状态检查和首条回复；在 marker、主库、queue、manifest、注册行和账号目录的每个持久化边界注入终止，使用 journal 或完整 staging tree 提供幂等 resume/rollback。README 只保留该门禁验证过的命令与依赖版本。 | 干净 macOS Native 与 Linux/WSL Docker Core 各完成一次；每个写入边界终止后重跑可以明确继续或回滚，不删除未知文件、不补空库；只设置 API key 但未选择 Provider 时给出明确状态；缺 Node、Docker、Codex CLI、LibreOffice 或 bubblewrap 时 doctor 返回可执行修复提示。 |

### P2

| ID | 现状与影响 | 实施方法 | 验收 |
| --- | --- | --- | --- |
| FLOW-003 | Provider 各协议的工具循环只检查当前一轮 Function Call。前一轮已经发送 `assistant_text` 或执行其他工具后，后一轮仍可能接受 `no_reply` 或 deferred tool，破坏“静默必须发生在任何输出之前”和 deferred acknowledgement 的顺序。 | 为一次 Provider completion 建立共享 `TurnToolState`，跨循环记录 `assistantTextSent`、已接受工具、deferred 状态和调用次数；`no_reply`、deferred 识别与 executor 共用该状态。Responses、Chat Completions、Anthropic、Gemini 和 Codex 适配器使用同一状态测试。 | 任意跨轮 `assistant_text → no_reply`、普通工具 → `no_reply`、`assistant_text → deferred` 均返回工具错误且不产生非法终态；合法的首轮 `no_reply` 与单独 deferred 保持现有行为。 |
| RECOVERY-001 | restore 逐文件 rename。若进程在一个或多个 rename 完成后崩溃，目标目录会同时存在恢复意图和部分新文件；再次执行会因非空目标安全拒绝，能够防止覆盖，却没有自动 resume 或 rollback，恢复流程需要人工判断。 | 为每个数据库的备份、目标替换和校验写入 fsync 后的 journal 状态，并让命令按 journal 幂等 resume/rollback；也可先在同文件系统完整构造和验证目标树，再进行受控原子目录切换。保留原目标备份直到所有 Agent 双库校验完成。 | 在每个 rename 前后注入进程终止，重跑能明确继续或回滚；任何时点都不覆盖未知文件，不丢失原目标；恢复完成后 manifest、哈希、SQLite 完整性和 queue 不变量全部通过。 |
| ONBOARD-005 | `./sunabot.sh --help` 当前按缺少有效命令退出非零；`status`、`doctor` 和 `logs` 也会进入依赖安装路径，读操作可能执行 `npm ci`，延迟检查并修改工作树依赖。 | `help/-h/--help` 作为成功命令退出 0；把 bootstrap/install 与只读命令分离，只有 `up`、`restart` 或显式 `bootstrap` 可以安装依赖，其他命令发现依赖缺失时返回稳定状态和下一步命令。release 直接使用随包生产依赖。 | help 退出 0；status/doctor/logs 在缺依赖 fixture 中零文件写入、零网络访问；up 的首次安装可观察且失败可重试。 |

## 实施顺序

优先处理 FLOW-001 和 FLOW-002，确保多账号投递具备故障隔离和外发至多一次的持久边界；MIG-001、MIG-002、RECOVERY-001 与 ONBOARD-004 的中断恢复演练并行推进。运行状态协议稳定后再接入账号 reconciler 和完整首次运行 E2E，最后统一 Provider 跨轮状态与只读 CLI 行为。
