# TODO-driven 项目结构整理与架构演进

日期：2026-07-14
目标设计：`docs/architecture/project-structure-plan.md`
问题依据：`docs/audits/2026-07-11-codebase-audit.md`、`docs/audits/2026-07-14-business-flow-audit.md`
当前行为：`docs/specs/current-system-spec.md`

## 使用规则

- 按里程碑顺序执行；未满足依赖和门禁的任务不能提前合并。
- 每个任务单独提交，目录移动不能夹带业务语义修改，数据迁移不能夹带模块重构。
- `[x]` 只有在代码、测试、运行证据、迁移/回滚和当前规范同时更新后才能勾选。
- 重构期间保持 npm 命令、管理 API、OneBot 行为、SQLite 数据和 Agent 文件兼容；临时 facade 必须有删除任务。
- 所有增长型业务数据继续使用 SQLite；禁止以结构整理为理由恢复 JSON/JSONL 持久化。

## 已有基线

- [x] NapCat 已收敛为独立 Docker 组件，Core Native/Docker 共用专用 OneBot listener、token 和内联媒体契约。
- [x] 当前 `npm run verify` 通过 165 个 Vitest 文件、910 项单元/集成测试、独立 runtime smoke 的 14 项测试和 33 项 E2E；当前视觉回归 8/8 通过，并已检查桌面/移动端、light/dark 的状态、Agent 和 Provider 截图。
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
  - CLI、管理 API 和平台入口共用只读 probe，分别报告 Core、OneBot、每个 QQ、Provider、Codex、LibreOffice、bubblewrap、workspace 和迁移状态。
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

## 2026-07-13 WebUI 修复 TODO

- [x] **WEBUI-FIX-001｜路由离开保存**
  - 未保存设置的离开弹层同时提供继续编辑、保存并离开、放弃并离开；保存失败时留在原页面并显示结果。
  - 验收：覆盖保存成功、保存失败、继续编辑和放弃修改的 E2E。
  - 证据：提示词冲突恢复与设置离开确认 E2E 覆盖全部动作；群聊回复联动草稿的放弃离开回归通过。

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
  - 证据：SQLite 聚合、精确会话筛选、失败调用、显式重试、Retry-After、正文断流、取消预检、Deferred Codex 终态竞争、自拍改写、会话消息分解和响应式面板均有回归测试；当前全量 165 个 Vitest 文件、910 项测试通过。

- [x] **WEBUI-FIX-011｜Bash 与 Codex 能力状态**
  - 工具开关始终可配置；配置启用、运行能力和最终可用状态分别展示；Codex Worker 可执行；Bash 仅在通过 bubblewrap 隔离探针的运行环境可执行。
  - 验收：配置开关不被能力状态锁死，Codex 登录与调用链可用，Bash 在支持环境执行、在 macOS Native 或探针失败时明确安全拒绝。
  - 证据：`/api/tools` 与真实回复 Provider 共用能力解析器，配置状态与运行能力独立；Codex CLI `0.139.0`、workspace 授权、Docker 镜像、worker authFile、Bash 隔离探针及通过/拒绝路径均通过回归、运行契约和 Native doctor。Apple Silicon linux/amd64 模拟内核返回 `EINVAL` 时保持明确安全拒绝，不降级普通 Bash。

- [x] **WEBUI-FIX-012｜规范与完整验证**
  - 当前系统规范、功能索引、Mock API 和测试与修复后的行为一致。
  - 验收：`npm run runtime:contract`、`npm run check`、`npm test`、`npm run build`、`npm run test:e2e`、`npm run test:visual` 和 `./sunabot.sh doctor` 全部通过，并人工检查关键截图。
  - 证据：运行契约、架构门禁、备份门禁、类型检查、165 个 Vitest 文件 910 项测试、14 项 runtime smoke、生产构建、33 项 E2E 和 8 项视觉矩阵通过；人工检查桌面/移动端、light/dark 的状态、Agent 和 Provider 关键截图。

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
  - 证据：聚合前向迁移、缓存 Token、失败调用、Provider 状态与正文重试、Deferred Codex 迟到用量、自拍改写、会话统计与响应式面板全部通过回归；当前全量 165 个 Vitest 文件、910 项测试通过。

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
  - 定义管理台回环端口、OneBot 专用端口、Compose 服务、宿主网关、media、secret、启动/停止、健康和 capability；锁 Node/NapCat/Codex/LibreOffice 版本、digest、checksum、license、architecture。
  - 完成：contract schema、component lock、SBOM、许可证和升级 smoke gate 入库。
  - 阶段证据：runtime contract、schema、component lock、Node/NapCat/Codex/LibreOffice/bubblewrap 版本与多架构信息已入库并通过静态门禁；SBOM 产物、全部许可证复核和升级 smoke 仍待完成。

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
  - 对 websearch、图片、自拍、Codex、Bash、LibreOffice、OneBot 文件和管理台建立同一 capability test。
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
