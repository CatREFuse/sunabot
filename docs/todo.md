# TODO-driven 项目结构整理与架构演进

日期：2026-07-14
目标设计：`docs/architecture/project-structure-plan.md`
问题依据：`docs/audits/2026-07-11-codebase-audit.md`、`docs/audits/2026-07-14-business-flow-audit.md`
当前行为：`docs/specs/index.md`

## 使用规则

- 按里程碑顺序执行；未满足依赖和门禁的任务不能提前合并。
- 每个任务单独提交，目录移动不能夹带业务语义修改，数据迁移不能夹带模块重构。
- `[x]` 只有在代码、测试、运行证据、迁移/回滚和当前规范同时更新后才能勾选。
- 重构期间保持 npm 命令、管理 API、OneBot 行为、SQLite 数据和 Agent 文件兼容；临时 facade 必须有删除任务。
- 所有增长型业务数据继续使用 SQLite；禁止以结构整理为理由恢复 JSON/JSONL 持久化。

## 已有基线

- [x] NapCat 已收敛为独立 Docker 组件，Core Native/Docker 共用专用 OneBot listener、token 和内联媒体契约。
- [x] 2026-07-14 基线的 `npm run verify` 通过 165 个 Vitest 文件、910 项单元/集成测试、独立 runtime smoke 的 14 项测试和 33 项 E2E；该次视觉回归 8/8 通过，并已检查桌面/移动端、light/dark 的状态、Agent 和 Provider 截图。
- [x] 主业务数据与 session queue 已迁移到 SQLite，并保留现有前向迁移规则。
- [x] `npm run architecture` 已进入 `npm run verify`，当前依赖边界、public API、durable codec、ToolRegistry 与尺寸预算门禁通过。
- [x] SQLite 恢复点 manifest v2 已覆盖默认 Plana 与全部注册/磁盘发现 Agent 双库，`npm run backup:gate` 17 项通过并兼容 v1。
- [x] 目标结构、模块协议、双运行模型、业务流程审计和完成标准已形成文档。

## 2026-07-14 业务流程优先队列

完整证据、影响和验收方法见 `docs/audits/2026-07-14-business-flow-audit.md`。

- [x] **FLOW-FIX-001｜持久化回复门控**
  - reply、`no_reply` 戳一戳和 deferred completion 持久化门控快照，投递前重新校验抑制状态、发送者、epoch 和取消信号。
  - 证据：关闭/重开队列、关闭后重新启用、正文、戳一戳与异步结果回归通过。

- [x] **MEDIA-FIX-001｜历史图片引用与 Agent 图片历史**
  - 上下文使用稳定媒体句柄，异步任务保存 dispatch 快照，同用户自动历史、Agent 图片目录和生成图路径边界均有回归。

- [x] **ONBOARD-FIX-001｜空 workspace 人格与 Codex 授权**
  - 新 Plana/Agent 以 write-if-missing 创建人格与提示词；Codex 默认授权路径绑定外置 `SUNABOT_WORKSPACE`。

- [x] **ONBOARD-FIX-002｜清空管理员 QQ 默认值与多账号初始化**
  - 默认 `bot.adminQq` 为空；workspace 只初始化 `runtime/napcat/accounts/`，不再创建旧单账号目录。

- [x] **ONBOARD-FIX-003｜显式单 Agent 迁移启动门禁**
  - workspace 初始化、API 组合根与 AgentRegistry 在写入前校验版本化标记；主库出现后核对全部 Agent/账号状态与 Plana/primary 基线，完成标记额外绑定目标 workspace 和端口，未标记既有目录、篡改标记、注册漂移和符号链接路径拒绝启动且零补建。
  - 证据：空目录写入 `fresh-install` 标记并可恢复 marker 发布中断；完成标记绑定恢复点 ID、恢复 manifest、报告、源状态和目标注册哈希；结构已就绪但未标记时要求停服、检查配置与固定端口、全部账号端口及带 workspace 标签的全部活动容器并重建恢复点；迁移报告区分 runtime/prompt 的 copied 与 preserved 两侧哈希；默认与显式配置 API 直启、初始化、AgentRegistry 和单 Agent 迁移回归通过。

- [x] **RELEASE-FIX-001｜Linux 双模式发行与迁移资产闭环**
  - Linux 归档携带 Docker Core 构建上下文、预构建 Native Core、生产依赖、迁移脚本、门禁模块与迁移文档；发行入口要求干净且 revision 稳定的源码并重新生产构建，发行包迁移复算 schema v2 manifest 绑定的完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件哈希后使用随包构建。
  - 证据：runtime contract 校验发行清单包含完整源上下文和迁移 wrapper；manifest 核对 runtime contract、版本、Node、真实 Linux/x64、source commit、文件集合与 SHA-256，篡改依赖、锁文件和陈旧构建 fixture 失败关闭；Linux/amd64 Node 24.18.0 独立构建验证无 `.git` 的生产归档、迁移 dry-run、全部资产与 18/18 Compose/Docker 构建目标；旧单账号配置命令已移除，当前契约与 runtime smoke 只使用 `runtime/napcat/accounts/primary/`。

- [x] **FLOW-FIX-002｜多 Agent Web Chat 顺序与选库**
  - 每个 Agent 复用 Web Chat 顺序状态，模型调用进入 Agent 运行上下文；并发回合、连续 ID、Arona 日志与 Token 聚合选库回归通过。

- [x] **FLOW-FIX-003｜secondary 账号恢复、引用与身份路由**
  - 重启编排、引用与附件查询、嵌套引用、发送者身份缓存和历史身份补全全程携带 account ID。

- [x] **FLOW-FIX-004｜群聊 Thread 上下文前置节点**
  - 原始 `messages_64` 保持时间顺序、数量和正文，完整元数据用于索引；增量 Thread 状态进入 SQLite，显式引用由宿主继承，歧义由独立低成本模型分类，动态 sidecar 在主回复前受管注入。
  - Thread 模型在每个 Agent 的“群聊编排”设置中独立配置；旧 Agent manifest 回退 `gpt-5.4-mini`。模板渲染不依赖动态 sidecar 占位，分类失败和异步旧任务均保留原始消息并继续回复。
  - 证据：相关 20 个测试文件 280/280、runtime smoke 14/14、Thread 首次运行门禁、TypeScript/Vue 类型检查、runtime contract、architecture、生产构建、benchmark、E2E 36/36 和 light/dark 视觉回归 8/8 通过；真实 Native Core 重启后 readiness 为 ready，旧模板缺变量已用实际渲染器复现并修复，22:09 的真实群消息已成功写入 assistant 回复。

- [x] **ONBOARD-FIX-004｜兼容注销定向与 Agent 创建补偿**
  - primary 兼容注销只定向 primary；primary 可以退出 QQ 登录但不能移除，API 返回 `PRIMARY_ACCOUNT_REQUIRED` 且管理台隐藏移除入口；Agent 运行时初始化失败时删除注册记录、workspace 与临时回滚目录。

- [x] **FLOW-001｜P1｜按 QQ 账号隔离 outbox 断连状态**
  - outbox 持久化 `deliveryPartition=accountId`，claim 跳过离线分区，断连探针与恢复按分区维护。
  - 验收：同 Agent 一个 QQ 离线时，其他在线 QQ 继续按序投递，重连只恢复目标分区。
  - 证据：断连、探针远端成功后 settle 失败、`delivery_unknown`、传输前失败和跨分区 FIFO 回归通过；v2 `sending` 升级为人工确认状态，不自动重发。

- [x] **FLOW-002｜P1｜远端发送与本地 settle 两阶段化**
  - OneBot 成功后持久化 remote receipt，再幂等完成会话、日志与 hook；未知结果进入 `delivery_unknown`，不自动重复发送。
  - 验收：远端成功后的任一本地故障和重启都不会产生第二条 QQ 消息。
  - 证据：会话投影、请求日志、记忆和逐 handler hook 使用稳定 settle key；真实 SQLite 关闭、hook 两侧崩溃、多 handler 部分成功及人工 `applied/not_applied` 回归通过。

- [x] **MIG-001｜P1｜SQLite 旧数据迁移恢复边界**
  - 备份路径改为 workspace 相对且拒绝逃逸；主库、queue、附件 chunks 使用统一 manifest、哈希、记录数和 restore/drill 门禁。
  - 证据：同计数异 ID、重复导入、活动 WAL、外置 workspace、完整父链符号链接和 macOS `/tmp`/`/var` 受控别名回归通过。

- [x] **MIG-002｜P1｜workspace 布局迁移完整回滚**
  - 敏感内容必须拥有受控离线恢复副本；所有移动项记录源/目标哈希，使用 staged copy、校验和原子切换。
  - 证据：未知目标替换、预存相同目标 rewrite 失败、复制与 rename 边界中断、retention/cleanup 外部路径攻击和安全回滚回归通过。

- [x] **ONBOARD-002｜P1｜统一 readiness 与 doctor 协议**
  - CLI、管理 API 和平台入口共用只读 probe，分别报告 Core、OneBot、每个 QQ、Provider、Codex、bubblewrap、workspace 和迁移状态；Office 正文解析随 Node 生产依赖交付，不再作为宿主 capability。
  - 证据：schema v1 probe、管理员 readiness、最小公开 health、Provider 凭据与有界健康请求、Gemini header 密钥边界、状态页三态及 8 个视觉用例通过。

- [x] **ONBOARD-003｜P1｜新 QQ 运行时调和**
  - 增加 account reconciler 与期望/实际状态；新增、运行、停用和删除账号只操作目标 NapCat，失败原因在管理台可见。
  - 证据：Docker Core workspace bridge、管理台单账号“运行”接口、daemon 缺失/超时持久状态、重复调和、目标账号隔离和注册库不可读零容器操作回归通过。

- [x] **ONBOARD-004｜P1｜空 workspace 首次运行 E2E**
  - 覆盖管理员设置、默认 Provider 选择、Agent/QQ 创建、扫码前状态、运行调和和首条回复；在 marker、主库、queue、manifest、注册行和账号目录的每个持久化边界注入终止，补齐幂等 resume/rollback；README 只保留该门禁验证过的步骤。
  - 验收：主库出现后的半初始化可以明确继续或回滚，不删除未知文件、不补空库。
  - 证据：Cookie+CSRF、Provider HTTP、OneBot WebSocket 入站到 QQ 回复受控 E2E，以及 6 个边界各 resume/rollback 的 12 次真实子进程 SIGKILL 通过；真实 macOS Native 与 Linux/WSL Docker Core 双 QQ 验收继续由 `DEPLOY-FIX-005` 跟踪。

- [x] **FLOW-003｜P2｜Provider 跨轮 TurnToolState**
  - 各协议共享本轮 `assistant_text`、工具、deferred 与 `no_reply` 状态，拒绝跨轮非法顺序。
  - 证据：Responses、Chat Completions、Anthropic、Gemini 和 Codex 覆盖跨轮非法顺序，合法首轮 `no_reply` 与 deferred 保持通过。

- [x] **RECOVERY-001｜P2｜中断恢复可继续或回滚**
  - restore 每次文件替换写入可 fsync 的 journal，重跑按 per-file 状态幂等 resume/rollback；也可使用完整 staging tree 校验后原子切换。
  - 验收：每个 rename 前后终止进程，原目标仍可恢复，重跑不会覆盖未知文件，全部 Agent 双库和 queue 不变量最终通过。
  - 证据：intent 先于 staging、复制与 rename 边界续跑/回滚、未知替换保留、完成后 SHA-256/SQLite/表计数复验和完整父链门禁通过。

- [x] **ONBOARD-005｜P2｜只读 CLI 不安装依赖**
  - help 成功退出；`status|doctor|logs|down` 零写入、零 `npm ci`，只有启动、重启或显式 bootstrap 可以安装依赖。
  - 证据：help、option-first `up`、`--core=docker`、`--core docker`、`--dev` 和缺依赖只读命令回归通过。

## 2026-07-16 生产隔离并行功能队列

当前生产 Core、账号调和进程、NapCat、SQLite 与 `workspace/` 继续由主业务终端唯一持有。以下功能分别在 `codex/system-config-tool`、`codex/sender-debounce`、`codex/send-file-voice` 和 `codex/bash-sandbox` 独立 worktree 开发，使用独立测试 workspace，不得启动或重启生产实例、操作生产容器、登录生产 QQ、覆盖生产 `dist/`，也不得占用 `8787`、`8788` 或 `6099`—`6101`。各功能分支只提交定向验证证据；统一集成、真实冒烟和 WebUI 设计收口由调度 worktree 接管。

- [ ] **TOOL-FIX-001｜P1｜管理员 `system_config` 工具**
  - 仅允许管理员 QQ 私聊和已认证 Web Chat 查询脱敏设置/状态，并调整当前 Agent 的自动回复、ambient 群聊编排、Tavily 搜索、管理员私聊 Bash backend，以及已存在群聊的回复与编排开关。
  - mutation 先进入 staged 状态，只在对应正文已进入 durable outbox 后提交，从下一轮生效；普通用户、群聊、伪造或未声明 Function Call 必须在 Provider 与宿主执行两层拒绝。
  - `codex/system-config-tool` 的功能与宿主端口合同、群聊分页及合同回归已由 commits `201b676e348f12476f12471b1c393c98015e1492`、`d25c896de558ac4293edb42ea4496d681e7fc8e4`、`2181fedac4d49666a3f631e9b77855b1eee169ea` 收口；真实 held v5 持久化、可信 provenance、原子 release/fallback、重启恢复、FIFO 与成功 turn 终态已由 clean commit `49d88d2ddc61d383cd07699321659c007a909847` 收口，并通过全量 188 files / 1,423 tests、类型、架构、runtime contract、生产构建及独立增量终审。该 commit 仍需与 Bash、媒体和文件工具统一合并并完成真实 QQ/NapCat 冒烟，本项保持未完成且不可单独上线。
  - 验收：覆盖每个 action 的正常路径、strict schema 非法组合、管理员/普通用户/Web Chat/群聊权限、完整 `conversationId` 与当前 Agent 隔离、outbox 成功/失败/重启竞态、热更新、Tavily-only 限制和敏感字段零泄漏；提交功能清单、精确测试名、命令与结果。
  - 风险：与 reply/runtime、ToolRegistry、Provider executor、配置 schema 和 Bash backend 共享入口；统一集成前不得直接落入生产 checkout。当前搜索实现只有 Tavily，不能把未实现的多搜索引擎描述为已交付；`get_settings` 仍只返回最多 100 条群摘要，超过摘要范围的已知群必须通过 query-only `list_groups` 稳定分页选择。

- [ ] **FLOW-FIX-005｜P1｜同发送者回复防抖与持久恢复**
  - 功能与恢复合同已由 clean commit `2d427f7d097ba9fee40633f6d28558a13388708d` 收口，并通过第二人 12 files / 244 tests、类型、架构、runtime contract 与生产构建门禁；真实 OneBot/重启冒烟和与 held/send_file/system_config 的冲突合并仍由 `INTEGRATION-001` 完成，本项保持未完成。
  - 私聊和群聊按 `conversation + sender` 执行 trailing 5 秒防抖；第一条满足触发条件的消息固定 route、引用目标与 reply gate，同发送者后续消息重置计时，其他发送者互不影响。
  - 释放时冻结 `contextThroughSequence`，把等待窗口内新增正文、图片、附件与群聊 Thread 注入同一次回复；ambient 判定进入同一链路，synthetic Session、未来 `availableAt`、running bump 与 source→target 原子 handoff 支持重启恢复。
  - 验收：覆盖单条、连续同发送者、并行不同发送者、私聊/群聊/ambient、首条引用不漂移、上下文截止点、图片/附件、取消与 reply gate、截止点竞态、进程重启、重复唤醒、跨 Agent/QQ 隔离和现有 FIFO/异步回调回归。
  - 风险：计时、持久事件与 reply/runtime 共享顺序语义；任何重复发送、漏回、引用漂移或恢复后提前执行都阻断集成。

- [ ] **MEDIA-FIX-002｜P1｜`send_file` 与默认禁用语音发送**
  - `send_file` V1 只向当前管理员触发消息提供 capability，支持管理员私聊或管理员所在群聊，目标始终冻结为当前会话；普通私聊、普通群成员、伪造 Function Call、直接 queue 与伪造 durable outbox 均 fail closed。工具只能把当前 Agent `workbench` 内的相对路径发送到当前单聊或群聊；图片使用消息段，普通文件使用目标会话对应的上传 action，不能接受任意 QQ、群号或宿主绝对路径。
  - 独立 `send_voice_message` 与 OneBot `record` 能力完成实现和测试，但本轮不注册、不向模型声明且默认不可调用。跨 Core/NapCat 媒体使用 `base64://`，outbox 只保存有界引用与内容摘要，投递前重新校验文件未被替换。
  - 功能与 durable conversation asset 合同已由 clean commit `2a23d44b4c7b883ed0dc65048399fb292aa97666` 收口，并通过独立终审的 14 files / 257 tests、类型、架构、runtime contract、生产构建与冻结指纹门禁；与 held/debounce/system_config/Bash/file tools 的冲突合并及真实 QQ/NapCat 冒烟仍由 `INTEGRATION-001` 完成，本项保持未完成。
  - 验收：覆盖管理员私聊/群聊的 capability 与当前目标冻结，普通私聊/普通群成员/伪造调用的零读取、零 outbox、零远端发送，以及图片/普通文件/语音协议、`account_id` 定向、越界、绝对路径、符号链接、非常规文件、大小/类型限制、排队后替换、读取失败、离线重试、未声明语音调用拒绝和 Native/Docker 相同消息契约。
  - 风险：大文件不能长期写入 SQLite 或绕过内联预算；账号串发、Core/NapCat 共享路径或文件替换后误发均阻断集成。普通 outbox fingerprint 只覆盖稳定副作用身份并刻意排除每次尝试可能变化的 `logRunId` 与 `replyGate`；完整 payload 继续由 canonical row、idempotency key 与有界 replay lineage 约束，规范与最终集成不得把两层合同混写。

- [ ] **BASH-FIX-001｜P0｜分会话 Bash 审计、确认与强隔离**
  - 基础安全模块已形成 clean commit `903f88905362822a37329d6bd7a14226b7323308`，Provider/runtime/server 原子 wiring 已形成 clean commit `ba8b66feb2a293981a16e4479f812e4a24aa8e7e`。wiring 冻结快照通过 16 files / 365 tests、86 项定向回归、类型、架构、runtime contract、生产构建、Compose 静态合同、diff-check 与独立终审，覆盖配置 epoch、A→B→A、audit/文件探针/审批/隔离各异步边界和最终 check-to-exec 零 await；两项 commit 仍需在 `INTEGRATION-001` 与 Provider raw-sibling preflight、媒体、文件工具和 W2 统一合并并完成真实隔离冒烟，本项保持未完成且不可单独上线。
  - 默认只有管理员私聊获得 Bash capability，并可在系统配置中选择 Native 或 Docker backend。若未来或既有显式配置允许其他 scope，也只能使用 Docker/等价强隔离 backend，并同时通过 `adminOnly` 与 `allowGroup` 双门禁；非管理员、未允许群聊与伪造调用始终拒绝。所有命令先经过独立模型审计，再经过不可被模型覆盖的确定性策略；永久高危命令始终拒绝，允许确认的越界操作使用一次性、绑定命令与会话的管理员票据。
  - `workbench` 是唯一可写数据边界。Native backend 只有在平台强沙箱探针通过时可用；macOS Native 缺少等价强隔离时必须安全拒绝或切换 Docker，不能执行普通宿主 Bash。Docker Core 不能通过挂载 Docker socket 放宽隔离。
  - 验收：覆盖管理员/普通用户/群聊、backend 切换、模型审计失败与超时、确定性永久拒绝、一次性确认重放、路径/符号链接/挂载/子进程/环境变量逃逸、超时与输出上限、Native/Docker 能力探针、macOS fail-closed、Docker Core 与 Linux/WSL 契约。
  - 风险：当前配置、Provider executor、reply runtime、管理 API/UI、Docker/launcher 和既有 `GATE-006` 均有交叉；基础安全模块先独立验收，共享接线后置。

- [ ] **TOOL-FIX-002｜P1｜独立 `read_file` / `write_file` 工具**
  - 在 Bash 安全边界稳定后实现独立工具，不通过拼接任意 Bash 命令提供文件能力。两项工具只处理当前 Agent `workbench` 相对路径，复用唯一真实路径解析与符号链接逃逸门禁。
  - 工具、Provider 日志正文投影、BOM 保真、权限与 runtime 宿主合同已由 clean commit `bbdc0557b4f48bdc453255bfa2807ad4afd7fe37` 收口，并通过全量 189 files / 1,424 tests、类型、架构、runtime contract、生产构建及两轮独立增量终审；五种 Provider 的发送前独占门禁已由最终集成 commit `76fdf807155322c6e043cad93f381db48b829f1d` 统一关闭，覆盖 sibling assistant 文本、其他 inline/deferred/`no_reply`/Bash 混批与 staged mutation discard，并通过全量 200 files / 1,857 tests。真实隔离冒烟完成前本项保持未完成且不可单独上线。
  - 验收：覆盖 UTF-8/二进制拒绝策略、大小和输出预算、目录与不存在文件、绝对路径/`..`/符号链接/竞态替换、原子写入、覆盖策略、并发写、权限错误、普通用户/群聊权限和 Agent 隔离；写入失败不能留下半文件。
  - 依赖：`BASH-FIX-001` 的 `agentWorkbench` 合同与 ToolRegistry/权限门禁。

- [ ] **AGENT-CAP-001｜P1｜Agent 级 Skill 与 MCP 安装、迁移和渐进披露**
  - Skill 与 MCP 按 Agent 独立安装、启停和升级，不读取其他 Agent 私有配置。Skill frontmatter 严格支持 `name`、`description`、`license`、`compatibility`、`metadata` 与实验性的 `allowed-tools`：`name` 为 1—64 位小写字母、数字和连字符且必须等于父目录名，`description` 为 1—1024 字符，`compatibility` 最多 500 字符，`metadata` 只允许字符串映射；`allowed-tools` 必须映射到 Sunabot 自身 policy，不能直接预授权。
  - W1 安全存储、归档校验、跨 Agent 预览/CAS 事务与管理 API 插件底座已由 clean commit `6bff0eca10d2c0405d8eee56a824f8503df1c1f6` 收口；26 路径通过 90 项专项测试、30 项真实 worker 崩溃/响应丢失测试、36 项 MCP 凭据负例，以及类型、架构、runtime contract、生产构建和独立终审。该提交尚未注册 server，也未接入 Provider/runtime、跨 Agent apply、MCP mutation、WebUI 或身份复验 GC，本项保持未完成且不可单独上线。
  - W2 后端、Provider/runtime、管理员 API、MCP Host/transport/OAuth、Skill 激活/迁移与沙箱投影已由 clean commit `7a7c6e3d201e0bf81b9f66c8d1664ff3f6b0419b` 收口；160 路径通过 parent-bound 47 项、相关矩阵 119 项、连续两轮 247 files / 2,544 tests、类型、架构、runtime contract、生产构建、两份 Compose 静态合同、diff-check 与独立安全终审，终审无开放 P0/P1。该提交已合入最终集成 head `87fdbbe622360253a59436410bd0128bc4cd84dc`；Skill/MCP 管理 WebUI、安装/迁移/OAuth/批准交互与当前 Agent 隔离由 clean commit `47922e8c358a58c14354ef0b5b5b0bec07e20874` 收口，A→B 乱序、失败与旧 mutation/OAuth/catalog 晚返回均有回归。真实 OAuth/HTTP MCP、Linux/WSL bwrap、Docker 镜像运行态与最终隔离冒烟尚未完成，任务继续保持未完成。
  - 初始上下文只注入当前 Agent 已启用且有权使用的 Skill `name`、`description` 与虚拟路径，预算为上下文窗口的 2%，窗口未知时最多 8,000 字符；超限先截短 description，再省略条目并记录有界警告。无 Skill 时不注入空 catalog，也不注册空激活工具；禁用或无权 Skill 完全隐藏。
  - Catalog 还必须限制绝对 Skill 数量、单 description 长度与总字节，省略时返回稳定 warning 和可分页列表入口。同一 Agent 的公开 Skill name 必须唯一；跨 Agent 迁移遇到同名时只允许管理员显式选择 skip、replace 或 rename，replace 使用原子交换与可恢复快照，模型不得看到两个同名候选。
  - 使用专用 `activate_skill` 工具按需激活，参数枚举只包含当前 Agent 的有效 Skill；结果只返回完整 `SKILL.md` 正文、虚拟 Skill 目录与有界资源清单，不主动读取资源。资源按引用继续读取，同一会话重复激活去重，激活指令在上下文压缩中受保护；无关 Skill 内容不得进入每轮提示词。
  - 可选 `agents/openai.yaml` 的 `allow_implicit_invocation=false` 必须进入目录 metadata 并从可隐式选择集合排除，但仍允许用户显式 `activate_skill`。其中声明的 MCP tool dependency 只作为缺依赖/待安装提示；Skill 包不能自动安装、启用或信任 MCP URL/transport，目标 Agent 必须逐项显式确认并经过同一 MCP 安全验证与 secret 授权。
  - Skill 脚本只经独立审计的 Bash 沙箱执行；若通过 Bash 读取资源，只提供固定 `/skills` 的受审计只读操作，不能把通用文件能力放宽到第二个宿主根。运行时禁止 `npx`、`uvx`、`bunx` 等临时联网下载；需要下载的依赖进入单独的锁版本、审核与缓存阶段，正常执行只使用预装或离线依赖。
  - 安装阶段可使用不含生产凭据的独立受控 downloader/validator 联网，依赖必须锁版本、hash、许可证与来源并产出 digest-pinned 不可变包，随后进入受信镜像或 Agent 扩展层；runtime Skill 与 Bash 继续 `network none`，并拒绝 `npx`、`uvx`、`pip`、`npm` 等运行时安装。
  - 每次 Skill 安全审计至少记录 scripts、外部 URL、MCP 依赖、声明的文件访问面、内容 digest、来源与审核版本；任何内容变化使审核失效并要求重新审计。Skill 与脚本按软件安装对待，必须审查完整目录、硬编码凭据和工具组合。
  - 跨 Agent 迁移必须先展示来源、版本、文件清单、MCP 依赖、环境变量名、完整 MCP command/args 和冲突，再以预览 revision/内容摘要 CAS 复制、重新校验并原子安装。拒绝 symlink、hardlink、device、FIFO、archive traversal、未知文件与共享 inode；不复制密钥值、运行态、数据库或宿主路径。本地 MCP server 的 command/args 必须由管理员显式确认后才能应用。
  - Sunabot 刻意不跟随 Codex 本地 authoring 可接受的 Skill 目录 symlink；安装、迁移、快照与投影阶段的目录链和 leaf symlink 一律拒绝。迁移将重新校验的普通文件树复制到临时目录，计算 digest 后原子 rename，不复制 inode、MCP secret 或 OAuth 凭据。
  - MCP 生产实现固定使用官方 TypeScript SDK v1.x，不跟随仍处 beta 的 v2；按 MCP `2025-06-18` 完成 initialize、版本与 capability 协商，每个 server 使用独立 client/session，只调用已协商能力并处理分页、`listChanged`、deadline、cancel、progress 与有界脱敏日志。
  - Client 必须设置 `enforceStrictCapabilities: true`；服务端协议版本不在 allowlist 时立即断开。V1 不注册、转发或接受 tasks、sampling、elicitation 与 experimental capability；只有沙箱快照真实就绪后才声明 roots。
  - 不使用 SDK 内建的单页 listChanged auto-refresh。Sunabot 收到 tools/resources/prompts 变更通知后执行有界完整分页，限制页数、总数、总字节并拒绝重复或循环 cursor、名称和 URI 冲突，全部成功后原子替换按 `agentId + serverId` 隔离的目录与 output-schema validator 快照；任一页失败保留旧快照并把 server 标为 degraded，不能发布半页或丢失前页 schema。
  - 每个 list/read/get/call 都传显式 RequestOptions、AbortSignal、分级 deadline 与 `maxTotalTimeout`；默认不允许 progress 重置超时，只有管理员批准的长任务可以在总上限内重置。会话取消、Agent 切换、server 禁用/卸载必须联动 abort，迟到响应丢弃；server reason/error/data 只映射为截断脱敏的稳定错误码。
  - W2 固定依赖 `@modelcontextprotocol/sdk@1.29.0` 与 `zod`，使用 v1 单包的 `client/index.js`、`client/stdio.js`、`client/streamableHttp.js` 和 `types.js` 入口，不能误用 v2 拆包。`StdioClientTransport` 不能直接继承默认 HOME、LOGNAME、PATH、SHELL、TERM、USER 或 Windows 对应环境：使用 hardened transport/launcher，或显式覆盖为沙箱虚拟值并由 `--clearenv`/`env -i` 兜底；cwd 固定 `/workbench`，stderr 强制 pipe、限长和脱敏，单消息上限必须低于 SDK 默认 10 MiB。
  - stdio 进程由现有 Bash Phase A watchdog、进程组/`--die-with-parent` 或具名容器清理负责，不能退化为 SDK 只终止 launcher PID 的默认 close。Streamable HTTP 使用自定义受控 fetch，逐跳验证 HTTPS/localhost、redirect 与 DNS，拒绝私网、link-local、metadata、代理环境和超限/超时响应；静态或环境 header 均不得覆盖 Authorization、`Mcp-Session-Id`、`MCP-Protocol-Version`、Host、Cookie 等保留或凭据头。正常关闭有 session 时先有界 `terminateSession()`，再 `client.close()`；405 可作为不支持 DELETE 处理。
  - hardened stdio 使用 SDK 最小 `Transport` 接口复用 Phase A launcher、进程组、watchdog 与资源限制，不依赖 SDK `StdioClientTransport` 的宿主 env/cwd/stderr 默认。禁用、迁移或关闭 Agent 时必须按 `agentId + serverId` 有界销毁 client、session、进程/容器与全部缓存。
  - V1 完整支持 `tools/list`、`tools/call`、`resources/list`、`resources/read`、resource templates、`prompts/list` 与 `prompts/get`。tools/resources/prompts 的结果、描述、annotations 与 server instructions 都是不可信输入，统一限制大小、数量与 schema 深度；instructions 最多 512 字符。Prompt 只能由用户显式选择，不能由模型静默执行；写入、删除和开放网络默认需要确认，`enabled_tools` allowlist 优先于禁用列表。
  - 本地 server 仅使用 stdio，停止顺序为关闭 stdin、`SIGTERM`、超时后 `SIGKILL`。远端使用 Streamable HTTP，除 localhost 外强制 HTTPS，并验证 Origin、DNS rebinding、认证、协议版本与 session 生命周期；OAuth 使用 PKCE 和 resource audience binding，禁止 token passthrough。远端 MCP 由 Core 的独立受控 HTTP client 执行，不能通过放开 Bash 容器网络实现。
  - Agent MCP 配置只采用 Codex 兼容字段的安全子集：stdio command 在安装阶段解析为已批准的固定 absolute executable 与 argv，cwd 固定 `/workbench`；HTTP 只保存 URL 和 OAuth/bearer secret reference，V1 不接受任意 static/env header，Authorization、Cookie、Host、Origin、`Mcp-Session-Id`、`MCP-Protocol-Version` 与 `Proxy-*` 始终由宿主管理。`enabled_tools` 先 allow、`disabled_tools` 后 deny，未知工具不开放；`required=true` 只影响所属 Agent readiness/resume，不能拖垮其他 Agent 或 Core。
  - OAuth access/refresh token、code verifier 与 state 按 `agentId + serverId + account/subject` 分区保存在 OS keyring 或等价加密 secret store，普通配置只存 credential handle。V1 callback 只允许 `127.0.0.1`/localhost 与 OS 临时端口；state 短 TTL、一次性并绑定 Agent、server、浏览器 session 与精确 redirect URI，canonical resource 精确绑定 MCP URL。跨 Agent 迁移不复制 OAuth/token；目标 Agent 复制非秘密配置后必须重新授权。
  - Resources 继续由 server 自身访问控制；`file://` URI 不能映射到宿主路径。Roots 只允许向明确 server 暴露虚拟 `file:///workbench`，变更时发送 `roots/list_changed`，不能暴露 `/skills`、Agent workspace 或宿主 HOME。V1 不宣告 sampling 与 elicitation capability；未来启用时 sampling 逐次展示完整 prompt 并确认，elicitation 标明 server、允许拒绝/取消且禁止索取敏感信息。
  - v1 roots 实现必须声明 `roots.listChanged`、注册 `ListRootsRequestSchema` handler，并通过 `sendRootsListChanged` 通知变化；返回值始终只有 `file:///workbench`。
  - 验收：覆盖安装/启停/升级/卸载、预览后源或目标漂移、跨 Agent 迁移、同名同版本/冲突/部分失败与崩溃回滚、恶意 manifest、路径逃逸、链接/设备/超限包、无共享 inode、缺失依赖、秘密零复制、metadata budget、按需读取、激活去重与压缩保护、脚本审计、MCP 三类 primitives、分页/listChanged、per-server 隔离、连接失败、取消/强杀、重启恢复和多 Agent 隔离。
  - MCP 负例还要覆盖：未协商 capability 的列举/调用、多页刷新第二页失败、重复/循环 cursor、页数/总字节超限、第一页 output schema 在完整刷新后仍校验、progress 洪泛不能越过总超时、abort 后迟到响应丢弃且进程组/容器有界清理、未来协议或 experimental capability fail closed，以及 Agent/server 生命周期结束后零残留 client/session/cache。
  - 风险：Skill/MCP 配置属于可审阅小型文件，增长型执行历史仍写 SQLite；不得恢复 JSON/JSONL 业务持久化，不得让 `allowed-tools`、MCP annotations、server prompt 或伪造未声明调用绕过 Provider 工具声明与宿主权限。
  - 组合风险单独判定：`read_file`/`workspace_bash` 与 remote MCP/网络会形成数据外发链，不能因为每项能力分别获准就自动组合放行；Provider response 与 batch-level policy 必须在任何前置副作用前统一拒绝或要求明确审批。

- [ ] **AGENT-CAP-002｜P1｜沙箱 Skill/MCP 投影与环境变量白名单**
  - W2 commit `7a7c6e3d201e0bf81b9f66c8d1664ff3f6b0419b` 已实现 digest 固定投影、per-server secret 注入、stdio/HTTP 受控 transport、OAuth vault 与生命周期清理，并完成自动化与独立终审；`run_skill_script` runtime 继续硬禁用，当前只保留审查、投影、沙箱和镜像静态基础，不能把脚本执行能力标为完成。真实目标平台与 Docker 运行态验收完成前本项保持未完成。
  - Docker/等价隔离 backend 启动时按内容摘要冻结当前 Agent 已启用 Skill、脱敏后的 MCP 配置和明确声明且获批的环境变量名；Skill 与配置以只读快照投影，`workbench` 是唯一可写数据卷。配置只保存 env 名或 secret reference，值只按显式 allowlist 注入单个进程；禁止继承整份宿主 env、代理变量、Docker `Config.Env`、生产 secrets、Docker socket、其他 Agent 目录、Agent workspace 或宿主绝对路径。
  - 沙箱固定暴露 `/skills` 只读、`/workbench` 读写与脱敏 MCP 配置只读，不扫描宿主 HOME，也不提供隐式网络。远端 Streamable HTTP 由 Core 受控 client 访问；stdio MCP 与离线 Skill 可以使用现有无网沙箱。新沙箱读取最新摘要，运行中的快照不随安装、删除或版本切换漂移。
  - `/run/sunabot/extensions/mcp.json` 只投影非秘密配置与 secret reference。MCP secret 绝不能进入通用 `workspace_bash`、Skill 脚本或整个沙箱环境；每个 stdio server 启动时由宿主从 secret store 解析该 server 的 allowlist，以 clearenv/`env -i` 只注入该进程，server A 看不到 server B 凭据。远端 token 只在 Core 受控 HTTP transport 内组装；切换 Agent、禁用、迁移或删除时销毁旧投影、client、环境与 OAuth state。
  - Phase A Bash 继续 `network none`。stdio MCP 默认无网；声明网络需求的 server 只可进入按域名 allowlist 的独立受控执行配置，禁止 Docker socket、宿主代理 env 与宽泛 `*` egress。
  - 验收：覆盖 Skill/MCP 新增、删除、版本切换后的新沙箱可见性，digest 固定快照、只读 Skill/配置、`workbench` 持久化、环境变量缺失/拒绝/脱敏与零泄漏、跨 Agent 读取、roots 仅 `file:///workbench`、无 socket/无 HOME/无隐式网络、容器销毁、Native/Docker parity 和 capability probe。
  - 安全负例覆盖 Bash/Skill script 看不到任何 MCP secret、server 间 token 隔离、旧 client/env/OAuth state 在禁用或迁移后不可消费、非 localhost callback/`0.0.0.0`/state 重放/resource 或 redirect mismatch 拒绝、配置/HTTP错误/stdout/stderr/tool result/审计日志零 token 与零宿主路径，以及 required server 故障只降级所属 Agent。
  - 依赖：`BASH-FIX-001`、`AGENT-CAP-001`；任何凭据泄漏、越界挂载或配置串 Agent 都阻断交付。

- [ ] **INTEGRATION-001｜P0｜统一集成、完整验证与最终冒烟**
  - 在专用集成 worktree 以 held v5 clean commit `49d88d2ddc61d383cd07699321659c007a909847` 为会话与配置基线，再按功能 commit 汇总上述分支，记录 base/head、冲突解决、schema/spec 变化和回滚点；生产 checkout 只做低频只读巡检，最终部署前不得被开发构建覆盖。
  - Bash wiring 已以 commit `ba8b66feb2a293981a16e4479f812e4a24aa8e7e` 合入专用集成分支；W2 commit `7a7c6e3d201e0bf81b9f66c8d1664ff3f6b0419b` 随后完成三处手工冲突解析并形成当前集成 head `87fdbbe622360253a59436410bd0128bc4cd84dc`。冲突只涉及 `contracts.ts`、`server.ts` 与 `reply.ts`：保留 Bash 完整 audit/approval/epoch handle，再叠加 Agent extensions，且 `run_skill_script` 仍不可声明、伪造调用零副作用；合并态 `check`、16 files / 292 项冲突专项、全量 250 files / 2,575 tests、architecture、runtime contract、生产构建、两份 Compose 静态合同与 diff-check 已通过。隔离运行态冒烟完成前仍不可上线。
  - 快速隔离功能验收已在 head `de04049faedb0b6a8c39c577f5220d4a748b7d99` 完成：业务矩阵 17 files / 420 tests、runtime smoke 85 tests、WebUI E2E 36 tests 与 `127.0.0.1:28787` 生产构建冷启动 API smoke 全部通过；专用 workspace 为 `/Users/tanshow/Developer/sunabot-dev-workspaces/final-acceptance-20260717`，OneBot 测试端口 `28878`，MCP stdio 强制 disabled，未复制生产配置、凭据、QQ 登录态、Agent workspace 或 SQLite，结束后两个测试端口均已释放。真实 QQ、OAuth Provider、远端 MCP 与目标平台 Docker/bwrap 仍按本任务既有外部环境边界验收，不能用 fixture 结果替代。
  - WebUI 收口后的最终集成 head 为 `47922e8c358a58c14354ef0b5b5b0bec07e20874`；`npm run verify` 通过 258 files / 2,602 tests、runtime smoke 85 tests、性能基线、生产构建与 WebUI E2E 40 tests，`npm run test:visual` 通过 light/dark 共 10 tests。人工抽查 390/1440 及短屏浅深主题的扩展、MCP、会话、概览、设置、登录与 Web Chat 截图，无横向溢出、遮挡或触控目标回退；独立终审发现并关闭跨 Agent 旧数据竞态后，13 项定向单测与 4 项扩展 E2E 再次通过。
  - 2026-07-17 生产切换前已停服并创建、验证静态恢复点 `/Users/tanshow/Developer/sunabot/workspace/backups/sqlite-recovery/sqlite-recovery-20260717T084319551Z-0a5d67d5`，覆盖 3 个 Agent 的 6 个 SQLite 数据库；随后以 clean release worktree 部署 WebUI head，并用 hotfix commit `cf3e76c669c81b4972de9d9cf0558e397370f7f2` 补齐 `/extensions` SPA 深链。`main` 已原子快进到该 hotfix；原共享 dirty checkout 的全部改动与指纹 `66ab143023860d463d8f8e497fce702f1e9731b3428f485eba10a198cb6e8dcd` 保留在 `codex/frozen-shared-checkout-20260717`，未修改其 index 或文件。当前 Core 由 Node 24.18.0 运行，`8787/8788`、管理台首页、`/extensions`、OneBot health 与未授权 401 门禁均已现场确认，启动日志无 fatal/schema/migration 告警；Plana/Arona 的 5 次历史工作记忆压缩尝试通过 `open-arona-codex:gpt-5.6-luna` 执行时在 90 秒超时，持久化消息未丢失，调度器随后回到 0 running/0 immediately eligible，但约 12,308/10,073 条 pending 仍待后续 Provider 恢复与新阈值触发，作为生产阻断继续跟踪。三个 NapCat 容器 healthy，但只有两条 OneBot WebSocket 已建立，第三个账号仍需扫码登录后完成定向收发验收。MCP OAuth vault key 与 stdio runtime 尚未配置，readiness 按安全合同保持 optional degraded；真实 OAuth/HTTP MCP、Linux/WSL bwrap、Docker 镜像和三账号全链路证据未齐前，本任务继续保持未完成。
  - `system_config` held v5 必须让 `appendHeld` 在单个 SQLite 事务中直接写入不可 claim 的 `held` 记录，并与普通 outbox 共用 event ordinal；禁止先按普通 outbox append 再 `UPDATE`，避免出现可 claim 窗口。ordinary/held ordinal 碰撞、同 ordinal 的 `mutationFingerprint` 不一致或重试内容冲突均 fail closed，并保持 session 与 delivery partition FIFO。
  - 配置 commit 成功后的 `release()` 必须在 store 写入可信 `released` provenance 与 `mutationFingerprint`，并证明同一 runtime generation 的 private `scopeEpoch` 相对原 reply gate 恰好 `+1` 且 `conversationEpoch` 不变；跨 generation 只允许当前 private `scopeEpoch=0` 且 `conversationEpoch=0`。不匹配时保持 `held`，由恢复流程改写为固定中性文案“设置结果未确认，请重新查询当前设置”。`fallback_released` 必须保留同等可信 lineage，并在投递时继续重验管理员、sender、conversation record、account、gateway、FIFO、retry 与 settle；只有 payload marker、缺少可信 `hold_state` 或 fingerprint 的记录一律走普通完整 gate。
  - startup recovery 必须在同一事务中把遗留 `held` 改为固定中性文案的 `fallback_released`，同时终结对应 origin running turn 与 head event；已经 `released` 但尚未 finish 的 turn 也不得再次执行模型或再次提交配置。`finishTurn`、`defer` 与 `fail` 对遗留 held 提供同样的 `fallback_released` 安全网，转为可投递后必须调用 `scheduleOutbox`；原子 neutralize/release 失败时继续保持 held，release 响应丢失的重试不得产生重复 outbox 或重复远端确认。
  - `replayUnknownOutbox` 必须从 store 保留原有可信 `released`/`fallback_released` lineage 与 `mutationFingerprint`；`hold_state=none`、普通 outbox 或只有 payload marker 的记录不得在 replay 时升级为系统配置确认。恢复、重放、fingerprint mismatch、gate delta 不匹配和后续普通回复被新 gate 拒绝均需 SQLite 重启级回归。
  - 自动化：逐项运行定向测试、`npm run runtime:contract`、`npm run architecture`、`npm run check`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run test:visual` 和 `npm run verify`，保留命令、结果、日志与截图路径。
  - 手工：在隔离 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 环境验证空 workspace、管理员/Provider、双 QQ 登录、私聊/群聊/@/引用、文字/图片/文件、账号定向、异步回调、重启与冷启动恢复、SQLite/queue/Agent 隔离、OneBot token/连接 owner 和无旧新 runtime split-brain。
  - 完整 launcher 固定使用 `8787/8788/6099+`，不得与同机生产实例并行启动；真实 Native/Docker + NapCat 验收必须在独立 QA 主机/VM 执行，或进入最终停服切换窗口后执行。现有 `smoke:runtime` 的 `127.0.0.1:18878` 回连只作为 fake NapCat 证据，标准 bridge-mode NapCat 容器不能把该宿主回环地址当真实回连证据；若继续复用 smoke launcher，必须先新增并验证 container-reachable advertised host，且不能放宽生产端口边界。
  - 隔离 runtime smoke 已由 clean commit `8b1789001da4e7ae6f9763012d9388a66d7c3c83` 增加受控 advertised host：默认仍为 `127.0.0.1`，显式仅接受精确 `host.docker.internal` 或 canonical RFC1918 dotted-decimal，端口保持 1024—65535 canonical 十进制并拒绝 `6099/8787/8788`；85 项攻击/兼容回归、类型、架构、runtime contract、构建与独立终审通过。该能力只解除同机隔离测试 NapCat 回连阻断，不替代双环境、双 QQ 的真实部署验收。
  - 当前生产特别核对三个 NapCat 容器只有两条已建立 OneBot 连接的差异；容器 `healthy` 或 CLI `connected=unknown` 不能替代三个账号逐一真实在线和定向外发证据。
  - 任一数据完整性、重复实例、账号串发、路径越界、媒体错误、权限绕过、恢复失败或生产边界被触碰都阻断部署并按对应功能 commit 回滚。

- [ ] **DEPLOY-FIX-005｜P1｜双环境双 QQ 迁移与上线验收**
  - macOS 使用 Native Core + 多 NapCat Docker，Linux/WSL 使用 Docker Core + 多 NapCat Docker；两端都必须由拥有仓库与 workspace 的非 root 用户通过根 `./sunabot.sh` 操作。已有实例按类型完成停服、恢复点、迁移、启动和回滚演练；fresh install 只初始化当前结构并验证回滚路径。禁止旧单容器、旧单 Agent 与新运行时并行。
  - 服务端拉取目标提交后先分类 fresh install、旧单容器、旧单 Agent 或当前多 Agent：fresh install 只初始化当前 schema，不运行旧布局迁移；旧单容器严格执行 `docs/migrations/one-container-to-split-runtime.md`，旧单 Agent 严格执行 `docs/migrations/single-agent-to-multi-agent.md`；完成旧布局迁移后与当前多 Agent 一样继续执行本版 schema 前向升级、远端 workspace 自有记忆导出/提案/重整，以及表情数据库记录与文件配对核验，不能复用本机记忆内容、row ID、提案或迁移报告，也不能重复执行已完成迁移。
  - 两端分别验证双 QQ 私聊、群聊、@、引用、文字、图片、文件、Base64 媒体、账号定向外发、异步 callback、outbox、Agent/SQLite/queue 隔离、重启与冷启动恢复；同时核对 OneBot token、连接 owner、account runtime daemon 单实例和全部旧进程退出。
  - 功能验收还必须覆盖：每 Agent 最多 9 张必填备注自拍素材、节点严格选择 1—3 张已知唯一 ID；表情生成、上传、数据库/文件配对与真实 `[/key]` 外发；群聊编排器精确 JSON 字段、候选消息 ID 与 deferred 原始结果不变；记忆重整逐 Agent/来源前后数量、原恢复点、changed recovery 和签名完成报告。
  - 验收证据必须记录准确 Git commit、运行模式、恢复点 ID、迁移报告、记忆前后计数、数据库/文件配对摘要、`status`/`doctor`、真实收发结果和回滚路径；单端 fixture、容器 healthy、端口监听或受控 E2E 不能替代双环境双 QQ 现场证据。

- [x] **WEBUI-DESIGN-001｜P1｜Nothing Design 视觉、功能与交互重审**
  - 仅在 `INTEGRATION-001` 功能冒烟通过后开始，使用 `$nothing-design` 对全部管理台页面做逐屏审查并实施修正；先确认起始模式，再同时交付一等质量的 light/dark。所需字体为 Doto、Space Grotesk 与 Space Mono，必须随构建本地打包，不依赖线上 Google Fonts。
  - 每屏只保留主、次、三级信息层级，以留白、排版、连续网格和必要分割线组织内容；禁止渐变、阴影、模糊、卡片套卡片、圆角卡片拼贴、装饰性色点、无功能动画、toast 和 skeleton。状态色只用于真实数据状态，用户可见文案只保留名称、状态、动作和结果。
  - 同步审查导航、Agent/QQ、设置、工具、会话、Web Chat、状态、日志、记忆、图片、登录、空/加载/错误/禁用状态；复杂表单保持二级页面或弹层，弹出菜单支持点击外部收起，语义 HTML、键盘、焦点、对比度、44px 点击热区和响应式对齐必须通过。
  - 验收：组件/E2E 功能回归，390/768/1440/1920 视口的 light/dark 截图，桌面与移动端逐页人工检查，菜单外部点击、键盘导航、无横向溢出、加载/失败/保存/离开、长文案和真实数据密度均有证据；改造后再次运行 `npm run test:visual`、`npm run test:e2e`、`npm run check`、`npm run build` 与受影响的 `npm run verify` 门禁。
  - 风险：视觉重构不得改变 API、配置归属、Agent/QQ 隔离、生产数据或功能语义；发现功能缺陷先补回归测试，再做最小修复。
  - 证据：clean commit `47922e8c358a58c14354ef0b5b5b0bec07e20874` 完成扩展中心、统一导航、主题首帧、Agent/QQ 选择、会话写入串行化、Web Chat 输入、日志与设置保存交互；本地字体、light/dark、390/768/1440/1920 与 390×568 短屏截图均通过。总门禁为 2,602 tests、85 runtime smoke、40 E2E、10 visual，独立 UI 安全终审无开放 P0/P1。

## 2026-07-13 WebUI 修复 TODO

- [x] **WEBUI-FIX-001｜路由离开保存**
  - 提示词正文的未保存离开弹层同时提供继续编辑、保存并离开、放弃并离开；保存失败时留在原页面并显示结果。普通设置已由 `WEBUI-FIX-013` 改为自动同步，不再使用该弹层。
  - 验收：覆盖提示词保存成功、保存失败、继续编辑和放弃修改的 E2E。
  - 证据：提示词冲突恢复与离开确认 E2E 覆盖全部动作。

- [x] **WEBUI-FIX-002｜提示词响应式工作区**
  - 横向空间充足时使用编辑器与可用变量表双栏；空间不足时变量表进入侧边弹层。
  - 验收：桌面、平板、移动端均无横向溢出，变量表只保留一个真实数据源。
  - 证据：390、768、1440、1920 四视口 light/dark 截图无横向溢出，宽屏双栏与窄屏抽屉均通过 E2E。

- [x] **WEBUI-FIX-003｜变量表交互与引用统计**
  - 变量表展示可用变量、来源、说明、当前引用次数和已引用总数；点击变量插入时保持输入区滚动位置。
  - 验收：引用计数、直接插入、自动 XML 包装与滚动位置都有组件或 E2E 回归。
  - 证据：人格和最终提示词分别覆盖引用计数、XML 包装、插入位置与插入前后 `scrollTop` 不变。

- [x] **WEBUI-FIX-004｜提示词语法与选区样式**
  - Markdown 支持标题、粗体、斜体、列表、代码块和引用的颜色与内联样式模拟；XML 只做语法着色；文本选区保持清晰对比。
  - 验收：Markdown/XML 单元测试与 light/dark 选区截图通过。
  - 证据：`PromptTextField` 6 项测试覆盖完整 fenced code block、转义和代码内非 Markdown 解析，浅深色选区截图通过人工检查。

- [x] **WEBUI-FIX-005｜编辑卡片、输入高度与分栏手柄**
  - 编辑器与变量表分别使用独立卡片，手柄位于两张卡片的间隙；输入区填满可用高度，宽度支持鼠标、键盘和双击复位。
  - 验收：长文本输入高度、手柄边界值、键盘调整、复位和四视口截图通过。
  - 证据：E2E 实测两卡片边界、16px 间隙手柄、编辑器高度比例、键盘调整与双击复位；四视口截图通过。

- [x] **WEBUI-FIX-006｜最终提示词统一交互**
  - 非人格最终提示词使用与人格提示词一致的双栏、变量插入和语法高亮；取消超宽多槽位并排，所有宽度一次只编辑一个槽位。
  - 验收：最终提示词 Tab、变量插入、结构测试、保存与宽屏布局 E2E 通过。
  - 证据：最终请求的消息组、排序、结构测试、JSON 保存、单槽位宽窄布局与变量抽屉 E2E 全部通过。

- [x] **WEBUI-FIX-007｜设置页结构与间距**
  - 通知与连接监控、OneBot 等 section 使用统一垂直节奏，不出现异常大留白或内容挤压。
  - 验收：连接设置四视口 light/dark 截图无错误文案、重叠和溢出。
  - 证据：连接设置独立四视口 light/dark 视觉矩阵通过，截图无异常留白、重叠、错误文案或溢出。

- [x] **WEBUI-FIX-008｜回复行为字段归属**
  - 启用私聊、启用 Bot 群聊、名称和命令前缀归入“回复行为”；连接页只保留连接与通知设置。
  - 验收：分区保存、放弃、冲突恢复和离开前保存不会丢失跨 section 草稿。
  - 证据：回复行为分区 E2E 验证字段只在目标页面出现且只提交 OneBot 分区；独立草稿、冲突与放弃测试通过。

- [x] **WEBUI-FIX-009｜自拍参考图入口**
  - 自拍参考图设置只出现在图像 Tab，支持上传、预览、删除和数量限制。
  - 验收：设置页无重复入口，图像页交互与四视口截图通过。
  - 证据：图像页上传、独立预览、删除、数量限制 E2E 与四视口管理弹层截图通过，设置页无重复入口。

- [x] **WEBUI-FIX-010｜模型调用统计与群聊详情**
  - 日志按回答、编排器、记忆压缩和其他统计调用次数与 Token；记忆拆分为工作与长期记忆、用户画像。工作记忆合并和长期记忆晋升由同一次模型调用完成，不重复虚构长期记忆调用。
  - 群聊详情展示累计、保留、可见、用户、回答和内部消息数，并显示同口径模型调用统计；页面可见且已选中会话时每 10 秒刷新。
  - 完成：失败且无 usage 的请求仍计入调用次数，显式传输重试逐次计数；Deferred Codex 和自拍改写保留会话、阶段与尝试上下文；统计写入 SQLite 聚合表并按完整会话 ID 精确读取。
  - 证据：SQLite 聚合、精确会话筛选、失败调用、显式重试、Retry-After、正文断流、取消预检、Deferred Codex 终态竞争、自拍改写、会话消息分解和响应式面板均有回归测试；当次全量 165 个 Vitest 文件、910 项测试通过。

- [x] **WEBUI-FIX-011｜Bash 与 Codex 能力状态**
  - 工具开关始终可配置；配置启用状态持续展示，健康能力不额外标记，只有能力异常时显示原因；Codex Worker 可执行；Bash 仅在通过 bubblewrap 隔离探针的运行环境可执行。
  - 验收：配置开关不被能力状态锁死，Codex 登录与调用链可用，Bash 在支持环境执行、在 macOS Native 或探针失败时明确安全拒绝。
  - 证据：`/api/tools` 与真实回复 Provider 共用能力解析器，配置状态与运行能力独立；Codex CLI `0.139.0`、workspace 授权、Docker 镜像、worker authFile、Bash 隔离探针及通过/拒绝路径均通过回归、运行契约和 Native doctor。Apple Silicon linux/amd64 模拟内核返回 `EINVAL` 时保持明确安全拒绝，不降级普通 Bash。

- [x] **WEBUI-FIX-012｜规范与完整验证**
  - 当前系统规范、功能索引、Mock API 和测试与修复后的行为一致。
  - 验收：`npm run runtime:contract`、`npm run check`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run test:visual` 和 `./sunabot.sh doctor` 全部通过，并人工检查关键截图。
  - 证据：运行契约、架构门禁、备份门禁、类型检查、165 个 Vitest 文件 910 项测试、14 项 runtime smoke、生产构建、33 项 E2E 和 8 项视觉矩阵通过；人工检查桌面/移动端、light/dark 的状态、Agent 和 Provider 关键截图。

- [x] **WEBUI-FIX-013｜设置自动同步**
  - Agent 设置、系统设置与独立会话设置中的普通配置使用单一实例串行自动同步，不显示通用保存、放弃或未保存离页确认；提示词正文继续显式保存。
  - 409 冲突刷新 revision 后只重试一次；第二次冲突、校验或网络失败保留当前输入并显示就地状态。路由离开等待队列完成，Agent 切换取消旧上下文请求；Bark 监控使用独立串行队列并保留密文占位与测试通知。
  - 验收：覆盖 Tone、输入防抖、Provider、工具、公共配置、Bark、会话回复与会话工具权限，运行组件测试、类型检查、架构门禁、生产构建、E2E、light/dark 视觉矩阵并人工检查桌面与移动端截图。
  - 证据：主设置 4 个组件与 composable 测试文件共 13 项、9 项 E2E 通过；独立会话设置 3 个测试文件共 16 项、3 项 E2E 通过；14 项视觉矩阵、类型检查与生产构建通过。390 与 1440 视口的 light/dark 截图无横向溢出，自动同步状态、校验错误、Bark 连接区与独立会话设置显示正常。隔离分支的架构门禁仅命中基线已有的 5 个超长文件，本次修改文件无新增违规，最终集成分支已完成对应拆分。

## M0：先建立不可回退的门禁

- [x] **GATE-001｜P0｜统一 Node 与 CI 运行时**（AUD-015、AUD-025）
  - 固定经过验证的 Node 24 小版本；`package.json`、CI、Native manifest 和 Docker 使用同一版本。
  - 完成：CI `npm run verify` 全绿，`node --version` 在四个入口一致，升级流程有回归清单。
  - 证据：`.node-version`、`.nvmrc`、package/lock、GitHub Actions、runtime contract、component lock、Core Dockerfile 和 release 统一为 Node `24.18.0`；版本漂移 fixture、runtime contract 和本地完整 `npm run verify` 通过。远端 GitHub Actions 将在本次推送后重新执行同一门禁。

- [ ] **GATE-002｜P0｜runtime doctor 与唯一实例门禁**（AUD-024）
  - 检查端口 owner、进程来源、release version、workspace realpath、数据库路径/inode、OneBot connection owner 和重复实例。
  - 启动/升级前发现 Windows/WSL 或 Native/Docker split-brain 时必须失败退出，不自动抢占数据。
  - 完成：正常、重复监听、错误 workspace、双数据库、僵尸 OneBot 五类 fixture 通过。

- [x] **GATE-003｜P0｜架构依赖门禁**（AUD-009、AUD-010、AUD-016～019、AUD-026）
  - 检查 services 不能导入 adapters/admin/deploy/tooling，跨模块只能导入 `public` API，无可执行循环。
  - 持久化 event/job/outbox 必须经过 versioned codec；工具 definition 与 executor 必须一一对应。
  - 文件原则上 `<800` 行、类 `<500` 行；超限必须有 ADR 和可追踪拆分 TODO。
  - 完成：`npm run architecture` 进入 `npm run verify`，并有故意违规的失败测试。
  - 证据：Agent config/repository、messaging contract、SQLite schema/model-call store、config revision 和 reply context 已按边界拆分；`architecture-gate` 违规 fixture 与当前仓库门禁通过，无活动债务例外。

- [ ] **GATE-004｜P0｜性能与容量基线**（AUD-013）
  - 建立 2,000 消息会话、80 会话并发、10 万/100 万日志、10 万记忆、10 万 queue backlog、20M 字符附件、1 万图片和 72 小时 soak 场景。
  - 记录吞吐、p50/p95/p99、事件循环延迟、RSS、GC pause、SQLite/WAL 增长、磁盘和 backlog oldest-age。
  - 完成：脚本位于 `tooling/benchmarks`，结果可复现并作为后续任务前后对比证据。

- [ ] **GATE-005｜P0｜备份与故障注入门禁**（AUD-011、AUD-012）
  - 建立主库与 queue DB 的一致恢复点、每日备份、7/30 天保留和季度恢复演练。
  - 覆盖 kill -9、磁盘满、SQLITE_BUSY、WAL 未 checkpoint、外发成功但主库写失败。
  - 完成：RPO `≤24h`，RTO 有记录；恢复后 `integrity_check`、记录数和队列不变量通过。
  - 阶段证据：manifest v2 已覆盖默认 Plana 和全部 Agent 双库，拒绝缺库、单边库、孤儿库、非法 ID 与路径逃逸；v1 兼容、验证、恢复和 17 项 gate 通过。每日调度、7/30 天保留、RTO 实测、restore 中断续跑和完整故障注入仍待完成。

- [x] **GATE-006｜P1｜Native Bash 强隔离**（AUD-003）
  - Linux/WSL 下使用独立用户、systemd 文件限制和经过验证的 bubblewrap/容器沙箱，不能只依赖字符串规则。
  - 完成：管理员 Bash 无法写出 Agent workspace，路径、符号链接、挂载和子进程绕过测试通过；Docker/Native 权限语义一致。
  - 证据：`services/tools/bashSandbox.ts` 固定只读宿主根与唯一可写 workspace，子进程继承 mount/PID 隔离并丢弃 capability；`tests/unit/bash-sandbox.test.ts` 覆盖路径、符号链接、挂载、子进程和缺失能力 fail-closed；runtime contract、Docker、Native systemd 与组件锁统一要求 bubblewrap。

- [ ] **GATE-007｜P1｜统一错误与观测协议**（AUD-014）
  - 关键降级、丢日志、队列积压、缓存淘汰、Provider/OneBot 断线和持久化失败都有稳定错误码、结构日志、计数和延迟指标。
  - 完成：故障注入能从指标定位到模块、correlationId 和恢复动作，不再用宽泛 catch 静默成功。

## M1：先固定协议，再移动代码

- [ ] **CONTRACT-001｜P1｜统一 EnvelopeV1 与 codec**（AUD-016）
  - 定义 `schemaVersion`、id、type、time、correlation/causation/idempotency 和 payload。
  - 未知版本进入明确 dead/needs-migration 状态，禁止 `as` 强转继续执行。
  - 完成：旧数据库 fixture 可读，新旧 codec、重启恢复、未知版本和前向迁移测试通过。

- [ ] **CONTRACT-002｜P1｜消息与媒体协议**（AUD-019）
  - 固化 `InboundMessageV1`、`OutboundMessageV1`、`MediaAssetRefV1` 和 `MessagingPort`。
  - OneBot/CQ/raw event 只能存在于 adapter；业务层不能看到 `OneBotGateway`。
  - 完成：内存 fake adapter 与真实 OneBot contract test 使用同一业务用例。

- [ ] **CONTRACT-003｜P1｜Session/Tool durable 协议**（AUD-016）
  - 固化 `TurnRequestedV1`、`TurnCommandV1`、`ToolJobRequestedV1`、`ToolJobCompletedV1` 和 outbox 状态机。
  - 完成：租约、重试、幂等、断线恢复和旧 payload 迁移测试全绿。

- [ ] **CONTRACT-004｜P1｜单一 ToolRegistry**（AUD-017）
  - Registry 同时产出管理元数据、模型 schema、权限/enable 状态、超时和 executor。
  - 删除 `tools.ts` 与 Provider 内的双重名字来源，统一 `workspace_bash` 等真实名称。
  - 完成：名称唯一、definition/executor 成对、UI/Provider/权限列表一致性测试通过。

- [ ] **CONTRACT-005｜P1｜Repository 与 UnitOfWork ports**（AUD-019）
  - 会话、session queue、记忆、媒体、日志各自拥有 repository port；跨领域事务显式声明。
  - 完成：services 不再调用 `applicationDataStore()`；SQLite adapter 可被内存 repository 替换测试。

## M2：先解除增长路径上的性能风险

- [ ] **DATA-001｜P1｜消息增量表**（AUD-006）
  - 拆 `conversations` 元数据与 `conversation_messages`，按条写入并建立会话/sequence/time 索引。
  - 完成：前向迁移、记录数与顺序校验、旧 API 兼容；2,000 消息持久化 p95 `<20 ms`。

- [ ] **DATA-002｜P1｜记忆调度行级存储**（AUD-004、PERF-002）
  - 待处理消息、游标、批次、失败次数和 retry time 按会话定向更新，不再整体快照。
  - 完成：80 会话并发 enqueue 不重扫全部历史，写放大接近 1，重启恢复一致。

- [ ] **DATA-003｜P1｜SQLite 写队列与 bounded claim**（AUD-004、AUD-020）
  - 高频写移出主线程或经有界批处理；SessionCoordinator 只按可用 actor 槽位预取。
  - 完成：10 万积压时内存队列不超过并发的 1–2 倍，RSS/续租 QPS 有上限，事件循环 p99 `<50 ms`。

- [ ] **DATA-004｜P1｜请求日志和终态队列治理**（AUD-005）
  - FTS5、游标分页、时间过滤、按类别保留和清理；session_events/turns/outbox/tool_jobs 终态归档。
  - 完成：10 万/100 万日志 p95 有基线，WAL/每日增长/清理数量可观测，清理不破坏审计链。

- [x] **DATA-004A｜P1｜模型调用行为统计与群聊成本详情**
  - 请求日志按回答、编排器、记忆压缩和其他记录模型调用；记忆压缩使用工作与长期记忆、用户画像两个真实调用类别，兼容旧 `working`、`long_term` 日志但不重复计数。
  - 日志页展示全局调用次数与 Token；每个群聊详情展示累计、保留、可见、用户、回答和内部消息数，以及 Token 和模型调用分类。
  - 完成：`model_call_aggregates` 与请求日志在同一事务增量写入，旧库前向重建聚合，分类总量无重复计数，按完整会话 ID 精确聚合，失败请求和实际传输重试如实计数。
  - 证据：聚合前向迁移、缓存 Token、失败调用、Provider 状态与正文重试、Deferred Codex 迟到用量、自拍改写、会话统计与响应式面板全部通过回归；当次全量 165 个 Vitest 文件、910 项测试通过。

- [ ] **DATA-005｜P1｜记忆索引与管理分页**（AUD-007）
  - FTS5 或增量常驻索引，管理 API 不再全量读取；保持现有召回语义。
  - 完成：10 万记忆 recall p95 `<200 ms`，结果语义回归、RSS 和 GC pause 达标。

- [ ] **DATA-006｜P1｜附件 top-K 与入口背压**（AUD-021）
  - chunks 在 SQL/worker 内 top-K；OneBot 缩小真实帧上限，禁止大文件 base64 内联并限制 intake backlog。
  - 完成：20M 字符附件查询不线性加载全量块；1,000 消息突发不会 OOM 或无限堆积。

- [ ] **DATA-007｜P2｜图片与缓存增量索引**（AUD-008）
  - 图片列表从 SQLite 读，目录核对改后台任务；图片异步/流式落盘；附件 cache index 行级更新。
  - 完成：1 万图片列表 p95 `<200 ms`，4K 落盘不造成明显事件循环长暂停。

- [ ] **DATA-008｜P2｜有界缓存生命周期**（AUD-014）
  - Sender、hydrated message、incoming preparation 等统一 bounded TTL/LRU、sweep 和指标。
  - 完成：72 小时 soak RSS 不持续增长，size/eviction/oldest-age 可观测。

- [ ] **DATA-009｜P2｜前端增量数据访问**（AUD-028）
  - 会话使用 cursor/SSE 和 single-flight；记忆使用服务端分页/搜索、debounce 和虚拟列表。
  - 完成：空闲标签页 QPS 接近 0，10 万记忆首屏 `<1s`，交互长任务 `<50 ms`。

## M3：按稳定缝拆核心业务模块

- [ ] **MODULE-001｜P1｜提取 delivery**（AUD-009）
  - 从 Runtime 提取 outbound mapping、媒体引用、MessagingPort 调用和 delivery error mapping。
  - 完成：私聊/群聊/引用/文字/图片、重试与断线恢复行为不变；Runtime 不再直接构造 OneBot action。

- [ ] **MODULE-002｜P1｜提取 messaging/intake**（AUD-009、AUD-019）
  - 提取 normalize、dedupe、route、reply gate 和 command match；OneBot adapter 只负责协议转换。
  - 完成：raw OneBot 类型不进入 service，突发背压与重复消息 contract test 通过。

- [ ] **MODULE-003｜P1｜提取 conversations**（AUD-006、AUD-009）
  - 提取会话、上下文预算、参与者、显示名和 repository；删除 Runtime 内的持久化 helper。
  - 完成：现有管理 API、上下文顺序、80 会话/2,000 消息限制保持兼容。

- [ ] **MODULE-004｜P1｜拆 reply 与 orchestration**（AUD-009）
  - 直接回复、群聊总结、用户群编排、ambient reply 分别拥有 application service。
  - 完成：取消/epoch/timeout/retry/门控回归全绿，Runtime 只调用 use case。

- [ ] **MODULE-005｜P1｜拆 memory bounded context**（AUD-010）
  - domain normalizer/merge policy、application batch、recall、scheduler、repository、admin/tool adapter 分离。
  - 完成：memory domain 不依赖 `admin/*`、Fastify 或具体 SQLite；事务和召回语义测试不变。

- [ ] **MODULE-006｜P1｜拆 Provider 与工具执行**（AUD-017）
  - transport、retry、stream decoder、image writer、ToolExecutor、日志分别实现 port。
  - 完成：Responses/Chat/Codex/图片/工具循环 contract test 通过，Provider 不按工具名 dispatch。

- [ ] **MODULE-007｜P2｜拆 media 内部组件**（AUD-021）
  - AttachmentFetcher、ContentAddressedStore、CacheIndexRepository、CacheJanitor、ParserPipeline 分离。
  - 完成：SSRF、CAS、quota、TTL、解析与视觉页测试各自独立，media 仍是一个部署模块。

- [ ] **MODULE-008｜P1｜拆 Fastify plugins**（AUD-018）
  - `apps/api` 只做 wiring/lifecycle；auth、conversation、onebot、memory、media、provider 路由各自注册。
  - 完成：41 条路由全部有 request/response schema，错误由 HTTP adapter 映射，E2E 不变。

- [ ] **MODULE-009｜P1｜落地目标物理目录**（AUD-026）
  - 移动到 apps/services/adapters/packages，并让 tests 镜像模块结构；保留短期 import facade。
  - 完成：architecture gate 全绿，旧 facade 有删除提交，当前系统规范和 AGENTS 索引同步更新。

## M4：分离开发脚手架、业务数据与运行依赖

- [ ] **STRUCTURE-001｜P1｜整理 tooling 与 Codex Web Coding**（AUD-026）
  - 建立 `tooling/codex|dev|quality|benchmarks|migrations|workspace`；根 `AGENTS.md` 只保留发现入口。
  - 保持现有 npm script 名称作为稳定用户接口，脚本内部不再要求从仓库根运行。
  - 完成：新 checkout 一条 bootstrap 命令可供 Codex 开始工作，一条 verify 命令覆盖所有门禁。

- [ ] **STRUCTURE-002｜P1｜消除 cwd 路径漂移**（AUD-024）
  - 代码根由 `import.meta.url`/release prefix 解析；数据根只由显式 `SUNABOT_WORKSPACE` 解析。
  - 完成：从任意 cwd 启动 Native、Docker 和脚本均指向同一 workspace；生产不再 cwd fallback。

- [ ] **STRUCTURE-003｜P1｜workspace 分层与快照等级**（AUD-023）
  - 目标为 business/runtime/secrets/cache/backups；清理临时 QR、审计源码副本和 smoke 产物。
  - 业务、NapCat runtime、secrets 使用独立快照策略，cache/tmp 永不备份。
  - 完成：幂等前向 migrator、加密快照、恢复和回滚演练通过；不能直接移动运行中的 DB。

- [ ] **STRUCTURE-004｜P2｜API/Web 依赖闭包分离**（AUD-027）
  - Web 依赖不进入 API production closure；release artifact 明确 API node_modules 和 Web 静态文件。
  - 完成：容器内无 Vue 构建依赖，Native artifact 与 Docker 使用同一生产闭包。

## M5：Core Native/Docker 与 NapCat Docker 同构

- [ ] **RUNTIME-001｜P1｜唯一 runtime contract 与组件锁**（AUD-022、AUD-027）
  - 定义管理台回环端口、OneBot 专用端口、Compose 服务、宿主网关、media、secret、启动/停止、健康和 capability；锁 Node/NapCat/Codex/officeparser 版本、digest、checksum、license、architecture。
  - 完成：contract schema、component lock、SBOM、许可证和升级 smoke gate 入库。
  - 阶段证据：runtime contract、schema、component lock、Node/NapCat/Codex/officeparser/bubblewrap 版本与多架构信息已入库并通过静态门禁；SBOM 产物、全部许可证复核和升级 smoke 仍待完成。

- [ ] **RUNTIME-002｜P1｜Native Core 入口**（AUD-022）
  - Core 使用同一 artifact 和 workspace；NapCat 始终由独立 Docker 服务运行，Native 入口不能安装或管理 NapCat 进程。
  - 完成：macOS 与干净 WSL/Linux 上启动、停止、升级、冷启动、扫码、文字和 `base64://` 图片通过。
  - 阶段证据：旧 Native NapCat 启动脚本和 systemd unit 已删除，Native Core 只通过统一 launcher 管理独立 NapCat Docker；macOS 本机检查通过，干净 WSL/Linux 实机消息矩阵仍待完成。

- [ ] **RUNTIME-003｜P1｜Core/NapCat 分离交付与统一 launcher**（AUD-022）
  - Core 镜像只包含 API/Web，NapCat 使用锁定的独立镜像；Compose 提供 `core` 与 `napcat` 两个服务。
  - 根 `./sunabot.sh` 统一 `up|down|restart|status|logs|doctor`，并支持 `auto|native|docker` Core 模式。
  - 完成：Docker Core 走私有网络，Native Core 走宿主网关；SIGTERM、冷启动、首次登录、真实文图消息和旧实例门禁通过。
  - 阶段证据：统一 launcher、多账号 NapCat 编排、专用 OneBot 端口、私有网络、release 入口、账号运行时调和和 readiness 统一协议已实现；Native/Docker 双形态真实多账号 smoke 仍待完成。

- [ ] **RUNTIME-004｜P1｜健康、资源和日志预算**（AUD-014、AUD-027）
  - Core 与 NapCat 分别报告 liveness；readiness 分层报告 API、OneBot、QQ、Provider，QQ 临时离线不形成重启风暴。
  - 两个组件分别配置 CPU/memory/pids/shm、日志轮转和磁盘水位；Bark 告警使用错误码和计数。
  - 完成：OOM/磁盘满/QQ 离线/Provider 离线演练不会形成重启风暴或静默故障。

- [ ] **RUNTIME-005｜P1｜Core 模式 capability parity**（AUD-022、AUD-025）
  - 对 websearch、图片、自拍、Codex、Bash、Office 正文解析、OneBot 文件和管理台建立同一 capability test。
  - 完成：同一 release/version/workspace fixture 在 Native Core 与 Docker Core 全部通过，跨组件消息不包含共享绝对路径；差异只能来自明确声明的可选 capability。

## M6：切换、清理与最终验收

- [ ] **ROLLOUT-001｜P1｜影子验证与切换**
  - 在隔离 QQ 测试账号/fixture 上验证新 runtime，禁止生产 QQ 同时连接两个实例。
  - 完成：doctor 无 split-brain，旧 runtime 停止后再切换，至少 24 小时稳定并完成一次冷启动。

- [ ] **ROLLOUT-002｜P1｜数据与行为全量验收**
  - 执行 SQLite checkpoint、备份、记录数、checksum、完整性、队列不变量和 workspace 恢复检查。
  - 完成：管理台、私聊、群聊、@、reply、文件、图片、记忆、Provider、工具和异步任务全部通过。

- [ ] **ROLLOUT-003｜P1｜删除兼容层和旧入口**
  - 删除旧 QQ Runtime 入口、Core 内 NapCat 资产、Native NapCat unit、cwd fallback、重复脚本和旧 workspace 路径。
  - 完成：`rg` 无旧路径/旧工具名/旧协议类型，安装包和 Git 中只有一个受支持入口。
  - 阶段证据：旧 Native NapCat unit、`native.mjs`、`qq-compose.mjs` 和 NapCat component 导出入口已删除，workspace init 不再创建旧单账号目录；迁移器仍保留受控 legacy 路径识别，完整 release 内容审计和兼容 facade 清理仍待完成。

- [ ] **ROLLOUT-004｜P1｜规范与交付收口**
  - 更新当前系统规范、功能—代码索引、README、部署、迁移、备份、安全和 AGENTS 文档索引。
  - 完成：`npm run verify`、architecture/contract/performance/Native/Docker gates 全绿，逐项审计本文所有 TODO 后再标记目标完成。

## 延后事项

- 完整 OneBot v12：当前生产协议是 OneBot v11。
- bot 群主动编排：当前只记录上下文，不主动回复。
- 多用户管理台权限：当前是单管理员自托管模式。
- 把业务模块拆成独立网络微服务：只有容量或故障隔离数据证明必要时再做，不作为本轮目录整理目标。
