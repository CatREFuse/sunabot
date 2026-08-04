# 持久化、迁移与安全

[返回当前系统规范索引](./index.md)

## 8. SQLite 持久化

### Agent 配置文件夹迁移

Agent 配置文件夹是跨终端传输角色配置的唯一推荐和支持模型。先将完整文件夹直接复制到目标机本地的任意受控目录，再在管理台新增 Agent 时选择该文件夹；浏览器把文件树提交给预检和原子创建流程。ZIP 只作为管理台选择文件受限环境的兼容输入，不是推荐的存储或传输格式。直接把文件夹复制到活动 `workspace/business/agents/<agentId>/` 不会登记 Agent，也不会绕过预检或原子发布。

可导入根目录只允许 `agent.json`、六个人格 Markdown、Agent 级最终提示词、受当前共享配置命名约束的 `system-prompts/` 覆盖、一个 `assets/avatar.(png|jpg|webp)`、规范 `selfie/references.jsonl`、兼容窗口内的旧 `selfie/references.json` 和受限自拍参考图。单层包装目录会在预检中展开；未知文件、密钥、`.env`、SQLite、队列、请求日志、备份、QQ 登录态、NapCat 运行目录以及链接或特殊文件一律拒绝。路径、Unicode、控制字符、重复名、ZIP slip、ZIP 链接、归档与展开体积、条目数量、UTF-8/JSON/JSONL 与图片类型均在物化前校验。

预检返回已包含的文件和缺失组件。缺失的 manifest、人格、最终提示词、头像、自拍素材或系统提示词覆盖使用目标当前默认值补齐；存在的 manifest 只允许受支持的 schema 与已知 Bot/OneBot 字段，来源 ID、名称、启用状态和秘密字段不会覆盖新增 Agent 的身份或当前部署凭据。创建先在受控临时目录写入默认 workspace，再写入通过预检的文件、归一化自拍清单并补齐缺项；目录 rename 与注册表写入任一失败时删除本次临时或已发布目录，已有 Agent ID 或目标工作区冲突稳定拒绝，绝不覆盖已有 Agent。

### 8.1 注册主库与 Agent 业务库

注册主库与默认 Plana Agent 业务库固定为 `workspace/business/data/sunabot.sqlite`，默认队列库固定为 `workspace/business/data/session-queue.sqlite`；外部主库覆盖已经退役，进程环境或 `workspace/secrets/runtime.env` 中出现 `SUNABOT_DATABASE_PATH` 时，launcher、doctor、API 和多 Agent 迁移器都会明确拒绝运行，其中 doctor 返回 `DATABASE_PATH_OVERRIDE_UNSUPPORTED`，迁移器返回 `CUSTOM_DATABASE_PATH_UNSUPPORTED`。其他 Agent 的业务库路径是 `workspace/business/agents/<agentId>/data/sunabot.sqlite`。各数据库使用相同的向前迁移 schema；Agent 注册表和管理员会话只以注册主库为准，其他业务表只读写所属 Agent 的数据，门禁、备份与恢复始终引用规范路径。

所有按 Agent 隔离的管理 API 必须显式接收并校验 `agentId`，缺失时返回 `AGENT_ID_REQUIRED`，非法值返回 `AGENT_ID_INVALID`；只有明确定义为跨 Agent 汇总的 Token/模型统计允许 `agentId=all`。任何路由、组合根或测试调用都不能把缺失值默认为 Plana，避免管理台选择漂移后读写错误数据库。

主库启用 WAL、`synchronous=NORMAL`、外键和 5 秒 busy timeout。当前表如下：

| 表                            | 数据                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `app_metadata`                | schema 与旧数据导入标记                                                                                  |
| `agents`                      | Agent ID、名称、启用状态、workspace 与头像路径                                                          |
| `agent_accounts`              | QQ 接入账号、所属 Agent、QQ 号、启用状态与独立 WebUI 端口                                               |
| `conversations`               | 会话及其消息数组，每个会话一行                                                                          |
| `memory_records`              | 长期记忆、用户画像，以及只读保留的历史工作记忆                                                        |
| `request_logs`                | 脱敏后的模型、工具、运行与 `memory.operation` 记忆操作日志；保留实际模型请求体、Provider 返回 payload、原始 usage 与统一 `tokenUsage` |
| `model_call_aggregates`       | 当前 Agent 按会话与行为聚合的模型调用总量                                                               |
| `model_call_model_aggregates` | 当前 Agent 按会话、模型、行为和记忆类型聚合的调用总量                                                   |
| `image_history`               | 生成图片历史元数据                                                                                      |
| `scheduled_tasks`             | 当前 Agent 的任务定义、revision、cron/once 计划、上下文、回调目标、永久保留标记与下一次/上一次触发时间 |
| `scheduled_task_runs`         | 到期 occurrence 的不可变任务快照、状态、lease、生成正文、错误与完成时间                                 |
| `admin_sessions`              | 管理 Cookie 哈希、CSRF Token、访问时间与有效期                                                          |

业务节点、记忆工具类型、成功/失败、尝试序号、最大尝试次数和重试次数是读取 `request_logs` 时从既有 category、action、request、response 与 metadata 派生的展示字段，不推进 schema，也不回写历史记录。`GET /api/request-logs` 的 `node` 与 `memoryTool` 使用固定枚举和参数化 SQL；业务节点条件与全文搜索在 `LIMIT/OFFSET` 前组合，避免分页后前端过滤。详情先按日志 ID 定位记录，再以参数化 `runId` 查询最多 200 条同轮日志，使请求、工具和响应跨分页仍可组合；返回值仍是既有安全投影，不能重新读取未脱敏 Provider 数据、记忆正文、称呼值、MCP 原文或宿主路径。

当前业务主库 schema 版本是 17；schema 10→11 创建的 STRICT `emojis` 与 schema 11→12 创建的 `emoji_versions` 仅保留为旧安装的表情 JSONL 迁移输入，当前表情 CRUD 不再向这两张表写入。schema 12→13 前向创建 STRICT `scheduled_tasks`、`scheduled_task_runs` 及 `scheduled_tasks_due`、`scheduled_task_runs_status`、`scheduled_task_runs_task` 三个索引，schema 15→16 为既有 `scheduled_tasks` 前向补充默认关闭的 `permanent_retention` 并创建 `scheduled_tasks_archive` 索引，schema 16→17 创建 STRICT `memory_source_revisions` 与三项记忆 revision trigger，并为 `scheduled_task_runs` 补充投递尝试、最后错误和下次投递时间。已升级 workspace 中可能保留停用的话题索引历史表；当前运行时不创建、不检查、不读取、不写入或删除该表。备份清单记录数据库实际表集和 storage schema version，恢复时原样保留额外历史表。恢复门禁只允许当前规范明确支持的旧 schema 作为迁移输入，并分别复核真实版本；当前 schema 缺任一必需表、索引、记忆 revision trigger 或投递列都判定为不完整。

当前工作记忆位于每个 Agent workspace 根目录的 `WORKING_MEMORY.md`，不要求 Git 跟踪。可见正文只由模型提供，宿主时间、会话来源和事项身份保存在隐藏 metadata；文件以 SHA-256 revision、64 KiB 上限、普通文件与符号链接拒绝、同目录 0600 临时文件和原子 rename 提交，工具、管理 API 与 Dream 共用该文件安全边界。长期记忆与用户画像继续使用 SQLite source revision。主对话中的 `add_workmemory` 与 `add_user_profile` 分别提交工作记忆文件和用户画像 SQLite 记录。Dream 同时捕获供模型读取的规范化长期记忆投影与供 add-only 提交的原始存储快照；提交必须从原始存储快照逐字段保留全部既有记录，不能把投影阶段补入的 schema、身份数组或事件指纹写回历史记录。提交顺序为工作记忆文件 CAS、长期记忆 SQLite 添加事务；SQLite 失败时按新 revision 回滚工作记忆。工作记忆 revision 漂移按软链接处理并保留当前文件，长期记忆 digest 漂移保持事务冲突。Dream 不读写 `AIR.md`、人格文件、长期记忆归档或召回统计。

生产 Dream 的 Provider 数据边界包含当前 Agent 快照中已存在的姓名、称呼、QQ 和参与者身份：这些值在封闭、有界的投影字段与事实正文中保持原值并发送给配置的 Dream Provider，不建立 `人物-*`、`person:*` 或其他身份哈希映射，也不把真实身份绑定另存为恢复表。凭据、秘密、邮箱、签名参数和宿主绝对路径仍在 Provider 请求前脱敏；旧式宿主身份代号不能进入新的有效模型输出或后续记忆、Dream、人格和 `AIR.md` 提交。user-test workspace 只复制非数据配置和明确授权的 Provider 凭据，生产业务 SQLite、WAL/SHM、记忆、会话、AIR、任务、Director、人格运行状态、runtime/cache/backup/voice、workbench、extensions 与链接均不复制；需要内容样本时只能使用只读来源生成独立的不可逆脱敏快照。

记忆操作审计复用当前 Agent 的 `request_logs`，不新增表或 JSON/JSONL。`memory.operation` 记录来源、操作、执行者、结果、稳定原因码、宿主时间、可用的 conversation/record 标识、数量与 revision；正文、称呼值、模型原始返回和宿主绝对路径禁止进入该事件。读取沿用现有请求日志分页与搜索，写入必须由当前 Agent 配置选择业务库，不能跨 Agent 汇总落盘。

`add_workmemory` 把 durable `incoming_reply` event ID 作为有界 `sourceDecisionKey` 写入 `WORKING_MEMORY.md` 的隐藏事项 metadata，不新增 SQLite 表或用户可见字段。追加在每次 revision CAS 前先查找相同决策键；崩溃恢复、重复 Provider 请求或 CAS 冲突重读命中时返回原事项和 revision，正文不再次追加。`add_user_profile` 使用相同决策键写入当前用户的聚合画像记录；重复执行命中该用户现有记录时返回去重结果，不新增第二条画像。旧 `memory_batches` 与 `memory_scheduler` 在 schema 初始化时显式删除，运行时没有对应 repository、队列或恢复逻辑。

既有 `bot.memory.dreamRecentWindowHours`、`dreamRecentMemoryLimit` 与 `dreamOlderMemoryLimit` 只为旧配置读取兼容保留，不再进入管理台、Dream payload 或运行决策。新建 Dream 运行把完整有界工作记忆批次、长期记忆只读去重上下文和安全上下文写入既有 `dream_runs.input_json`；后续重试复用同一输入。

Dream 严格输出解析失败复用 `dream_runs` 现有 `attempt_count`、`error_code`、`error_text`、`next_retry_at` 与失败时间字段。无效输出在 `markGenerated` 之前失败，自动 claim 最多累计三次；第三次后 `next_retry_at` 为空。generated 阶段只接受能够重新通过当前三字段合同的 parsed JSON；旧六字段、宽松或残缺产物清空生成结果并在下一次 claim 重新调用模型。错误只保存稳定代码与固定安全说明，不保存无效模型原文、Provider payload、秘密或宿主路径。

`emojis.jsonl` 一行对应一个 key，并严格保存当前文件名、key 创建/更新时间以及版本数组；`source` 只允许 `upload` 或 `generated`。单 Agent 最多 64 行，每行最多 20 个版本，清单最多 2 MiB。统一 key 校验层在任何清单或图片写入前拒绝原始孤立代理项、replacement character、C0/C1 控制字符、方括号、斜杠和反斜杠，再执行 trim/NFC，并限制为 1—24 个 code point、最多 64 UTF-8 字节；清单中的未知字段、重复 key、重复版本、悬空当前版本或非法值使读取失败关闭。旧 SQLite 毒值在迁移读取时隐藏，不能进入 JSONL 或令列表和内容 API 持续 500。

`scheduled_tasks` 的管理写入使用 revision CAS；创建、更新和重新启用时计算 `next_run_at`，调度器推进下一次时间不增加管理 revision。管理台分类和分页直接在 SQLite 查询：cron 始终属于“循环”；once 在仍可能触发时属于“定时”，在 `next_run_at` 为空且存在 `completed|failed` 运行后属于“归档”。归档定义以最近一次终结运行的 `completed_at` 起算保留三天；调度器把清理时刻纳入 `nextWakeAt`，到期删除 `permanent_retention=0` 的任务定义，保留不可变运行记录，重新安排过的 once 从最新终结时间重新起算。永久保留更新与普通编辑共用 revision CAS。`scheduled_task_runs` 以 `UNIQUE(task_id, scheduled_for)` 保证同一 occurrence 只建立一条运行记录，并保存触发时的任务 revision、上下文、计划和全部目标快照。到期 claim 在一个 `BEGIN IMMEDIATE` 事务内插入 `pending` run 并推进任务：延迟启动的 cron 只补一次最早到期 occurrence，再把下一次时间推进到当前时刻之后；once 触发后把下一次时间置空。运行状态按 `pending → running → generated → completed|failed` 推进并使用可续租 lease；渲染后的 callback input 先持久化为 `generated`，进程在分发途中退出后只重放入队，不重复渲染。投递异常持久化 `delivery_attempts`、`last_delivery_error` 和带抖动退避的 `next_delivery_at`，第三次失败终止；人工重新投递只接受 `failed` run，并在事务中清理错误、写入可立即过期接管的恢复 lease，使调度器复用同一 callback input。每个目标随后写入所属会话的 Session 事件，目标会话内的正常 Agent turn 再产生 durable outbox；当前 Agent 队列边界与 envelope 固化账号、完整会话、运行 ID、callback input 和结构化 `mentionUserIds`，以 run ID 在每个会话内幂等。任务定义与运行记录属于当前 Agent 业务库，会话事件和 outbox 属于当前 Agent 队列库；这些增长型数据禁止使用 JSON/JSONL 管理。

日常导演创建的定时任务保留 `director-` 确定性 ID 前缀；管理台与 API 直接由该前缀派生内部 `director` 分类，不新增分类列或推进 schema 版本。普通定时任务的 `all|recurring|scheduled|archived` 查询固定排除该前缀，导演页面单独读取 `director` 分类；归档保留与自动清理仍沿用相同 SQLite 生命周期。

会话工具选择随 `ConversationRecord` 写入 `conversations.data_json` 的可选 `disabledTools` 字段，不新增表或 schema 版本。写入只保留去重后的内置 Agent 工具名，空列表省略；读取旧记录时缺失字段规范化为空列表。QQ 与 Web Chat 会话分别使用完整会话 ID 隔离，Agent 切换继续由独立业务库隔离。

Plana 的 `workspace/business/data/session-queue.sqlite` 与其他 Agent 的 `workspace/business/agents/<agentId>/data/session-queue.sqlite` 分别保存所属 Agent 的会话事件、turn、异步任务和 outbox。当前 session queue schema 版本是 5；outbox 的 `hold_state`、`mutation_fingerprint`、`hold_provenance_json` 与 `release_provenance_json` 共同保存 `system_config` held confirmation，旧行向前迁移为 `hold_state=none`。fingerprint 只接受固定长度的小写 SHA-256；两份 provenance 使用版本化、有界、严格字段结构，状态与空值组合由 SQLite CHECK 和读取 decoder 双重校验。held append、release、中性化、origin turn/event 终结与恢复均使用事务，不能出现可 claim 的普通行到 held 行更新窗口。带构造期 lease 恢复的 SessionStore 必须同时注入 ReplyGate resolver；恢复遇到 held 行但缺失 resolver 时关闭数据库并失败，不能静默保留 running turn。附件缓存中的每个 `chunks.sqlite` 独立保存该文件的文本分块。

离线 SQLite 恢复点必须覆盖默认 Plana 与注册表中全部启用或停用 Agent 的业务库和队列库。创建恢复点时以注册主库和 `business/agents/<agentId>/data` 文件系统扫描结果的并集核对范围；注册 Agent 缺少数据库、单边数据库、未注册 Agent 孤儿库、非法 ID 或越界路径时失败。新恢复点使用 manifest v2，按 Agent 保存业务库与 queue 的 schema profile、校验信息和投递不变量；正常 v2 业务库必须包含当前统计、管理员会话和 Agent 注册表。校验时 manifest Agent 集合必须与备份内 Plana 注册表完全一致，恢复只接受完全空的目标 workspace，并由 manifest 清单安全重建嵌套目录。仅当 `agents`、`agent_accounts`、`agent.json` 和二级 Agent 数据库都不存在时，迁移前数据库才使用旧单 Agent schema profile。旧 manifest v1 仍可校验和恢复，范围仅包含默认 Plana 双库。

旧数据迁移按幂等键集合验证来源、导入前、导入后和真实增量，不能用总数相同替代记录身份一致。workspace 布局迁移和恢复先持久化 fsync journal intent，再逐文件记录复制、替换与完成状态；中断后可以继续或回滚，删除目标前必须复验类型、大小和 SHA-256，未知替换保持原样并失败关闭。恢复数据库在主文件物理证据通过后才清理精确同名且为普通文件的 WAL/SHM，并在每次 SQLite 校验关闭后再次清理只读检查生成的 sidecar；异常类型和 staging 内未知文件始终阻断发布。数据库迁移在 checkpoint 后持有独占锁，活动写事务停止迁移。恢复、演练、保留清理和 stale partial 清理对绝对路径完整父链逐级检查，仅允许 macOS 根级 `/tmp` 与 `/var` 指向系统 canonical 目录的受控别名。

既有记忆第一视角重整使用受版本控制的 `tooling/migrations/memory-perspective-v1.mjs`，真实正文、row ID、数据库相对路径、导出、内容提案、绑定计划、intent 和报告只保存在当前机器的 `workspace/business/migrations/`。在线阶段可以只读 `export` 三类 `memory_records`，但在线导出和候选只能作为 stale 审计证据；最终执行必须在同一次停服静默窗口重新导出。`export`、`refresh` 与 `dry-run` 先以纯文件系统方式收集精确 Agent 双库集合并记录真实主库、WAL、SHM 和迁移文档摘要，只复制主库、WAL 与必要文档到临时 workspace，SQLite 只打开临时副本；完成后真实文件逐项 CAS 不一致即失败。Agent 注册表与实际双库集合必须精确相同，不能隐式补 Plana。`generate` 只生成以稳定事实键表达、尚未绑定 row ID 的 unresolved 提案骨架，内容提案可由当前机器上的人工或模型任务完成；`sign` 固化审核结果并绑定实际 signed export、Agent 与输入集合，`refresh` 才在稳定数据库上机械绑定当前 row ID，并把 signed proposal/export 路径和摘要写入 plan。新增、删除、内容变化、重复 effective ID 或稳定键、歧义、遗漏、仅由旧 `{recordId,position,data}` wrapper 支持的目标、跨用户画像、未知字段、外部 artifact 路径或 Agent/数据库集合不一致都失败关闭，不能沿用在线 stale 计划。

记忆重整的真实命令顺序是 `export`、`generate`、人工或模型审核、`sign`、`refresh`、`dry-run`、双阶段 `prepare`、`apply`、`install`、`verify`；取消和恢复只使用 `abort`、`rollback` 及 rollback 返回的 `install` 命令。首次 `prepare` 在全部 Core 端口、进程和业务库/queue 句柄释放后绑定候选、replacement、当前数据库集合、完整 schema、关键 pragma 与逻辑摘要，并以 0600 原子 fsync intent 阻止 Core 启动；manifest v2 原恢复点必须在该 intent 之后创建。已有 intent 后，第二次 `prepare --backup` 只用文件系统 CAS 复验生产主文件、sidecar 和签名绑定，不再打开或 checkpoint 生产 SQLite；它完整验证恢复点的 manifest SHA 与备份内逐库物理、逻辑和 memory/protected 摘要，再把恢复点绑定到首次 `prepare` 已签名的完整 Agent 双库集合与候选 baseline。所有会创建、更新或清除 intent 的命令共用 workspace 级跨进程操作锁：先以 0600 完整写入并 fsync 唯一 owner evidence，再通过无覆盖 hardlink 发布 canonical lock 并 fsync 目录；发布、stale claim、崩溃恢复和释放均按 owner token、文件身份与 link count 对账并有界重试。当前 owner 的首次身份不能依赖外部 `ps`，外部 owner 只有在可信且规范化的进程身份确认不匹配后才可回收；活进程身份无法可信确认时保持锁定并失败关闭。零字节或截断 canonical、符号链接、错误权限、异常 link count、PID 复用和并发 successor 都不能被误认成可安全接管的锁。

生产业务库不执行逐 Agent 业务事务。`apply` 从入口起只用句柄、受信路径、sidecar 缺失和签名主文件 SHA 做生产纯文件 CAS，生产 SQLite open、write 与 checkpoint 必须全部为零；它通过已有恢复 journal 把原恢复点恢复到同一 filesystem 的空 staging workspace，只在 staging 业务库中使用参数化事务替换 `memory_records`，保持所有 queue 和非记忆表不变。完成逐行、schema、pragma、引用和 metadata 复验后，先创建并验证 changed recovery point，再对 staging 做最终 checkpoint、清除 sidecar，并仅用文件系统读取刷新稳定摘要，此后不能再次以 SQLite 打开 staging。`install` 在首个生产 rename 前只以纯文件方式复验生产 exact-before 与 live staging 的签名物理摘要，生产和 live staging 的 SQLite open、write 与 checkpoint 同样为零；原恢复点与 changed recovery 的 ID、manifest SHA、完整 Agent 双库集合的物理和逻辑摘要仍需全量验证，同时复验全父链、目录类型、WAL/SHM 稳定态、同盘关系和 data 目录 journal，再以可重入目录切换安装完整结果。任一恢复证据失效时生产保持 exact-before。强杀发生在 quarantine、rename 或 intent 更新边界时由同一命令按签名 journal 继续。安装后 intent 保持 `verifying`，`verify` 独立核对两份恢复点、plan、完整 row shape、业务库 full logical SHA、非记忆表和 queue；成功时先原子写 signed report 再清 intent。

任一 staging、安装、pending report、完整验证或回滚异常都保持启动阻断状态。可重试的停服确认、端口或句柄失败保留原状态。生产目录首次切换前的 `awaiting-backup`、`prepared`、`staging-restored`、`staging-applying`、`staging-failed` 与 `staged-ready` 都属于 PRE 状态；`abort` 只验证 signed intent、受信路径以及 Core 端口、进程和数据库句柄均已释放，随后写 signed abort report 并清除 intent。PRE `abort` 不读取 plan、backup 或 staging，不打开或检查任何生产及 staging SQLite，不执行 checkpoint，不删除 WAL/SHM，不比较 exact-before，也不因外部生产字节漂移进入人工恢复；生产文件及 sidecar 必须逐字节保持调用前状态。生产目录开始切换后的 POST 状态只能由 `rollback` 接管；旧 staging 丢失、损坏或换盘时从原恢复点重建新的同盘空 staging 和新 journal，再完整恢复签名绑定的 Agent 双库集合、写 signed rollback report 并清 intent。`verify` 对 pending report 的路径解析、读取、JSON、签名、状态和 intent 绑定都纳入同一失败捕获；报告缺失或损坏时只依赖已签名 intent 与原恢复点进入 `rollback-required`，不能用坏报告决定恢复路径。全部目录已经恢复后才发生的备份损坏，以 intent 中签名的完整 Agent 双库集合绑定和已验证 staging 证据完成收尾。存在、损坏或状态未知的 intent 一律阻止 launcher 与 API 直启，禁止手工删除。完整命令见本机 `workspace/business/migrations/memory-perspective-v1-plan.md`；通用 CLI 以 `npm run migrate:memory-perspective -- help` 为准。

记忆重整的授权与文件身份门禁在持久边界再次执行：第二次 `prepare` 写入 `prepared` 前重新读取、验签并精确比较 plan/replacement 全集，`apply` 在创建或打开 staging 前执行同一授权复核，prepared 后任何重签替换都失败关闭。恢复点、production、live staging 与安装 journal 中的 quarantine 数据库都必须是 `nlink=1` 的普通文件；首次恢复点 SQLite 校验前、最终 staged-ready 边界、首个 rename 前及安装重入的每次 rename 前，都按 `dev:ino` 对全部现存数据库做全集互斥复检，hardlink 或 bind alias 一律在任何 live SQLite 打开或目录替换前失败关闭。安装开始和重入还要递归拒绝 signed journal 外新增的业务库/queue 对；每个 current→quarantine 与 staged→current rename 紧邻前再次复验全集身份、路径绑定和目录内容摘要，主文件或 WAL/SHM 在复验间漂移时保留当时目录并进入可回滚状态。

### 8.2 文件边界

以下内容继续使用文件：

- `workspace/secrets/runtime.env`：本机凭据，不进入 Git；
- `workspace/business/config/sunabot.json`：schemaVersion 1 的模型、正常回复重试、共用开关和默认 Plana 配置，不保存明文密钥；缺失的小型允许字段由配置归一化与配置医生规则补齐，不支持的显式 schemaVersion 失败关闭；
- `workspace/business/migrations/multi-agent-v1.json`：首次安装或单 Agent 迁移完成标记，保存完整性摘要和迁移证据摘要；
- `workspace/business/migrations/memory-perspective-v1-*`：本机记忆重整的导出、内容提案、绑定计划、stale 证据、durable intent 和完成/回滚报告，包含真实记忆时不得进入 Git；未完成 intent 存在、损坏或状态不明时 Core 启动失败关闭；
- `workspace/business/prompts/`：所有 Agent 默认使用的公共系统提示词；
- `workspace/business/prompts/.sunabot-prompt-migrations.json` 与 Agent override 对应文件：保存提示词迁移版本、输入和输出摘要及完成状态；`memory-perspective-v7` 只按结构、当前完整指纹与已知旧版本精确内容迁移，无法识别管理员模板时记录无改写完成状态，原提示词字节保持不变且 Core 继续启动；
- `workspace/business/agents/<agentId>/agent.json`：Agent 名称、启用状态、系统提示词覆盖开关、Bot 行为、工具覆盖、Bash 对抗审批设置与 OneBot 行为配置；旧 `adminPrivateBackend`、`adminOnly`、`allowGroup` 仅保留配置兼容，不能改变 `native_bash` 与 `docker_bash` 的固定会话权限；
- `workspace/business/agents/<agentId>/workbench/skills/`：schemaVersion 1 Skill 索引、已验证 Skill 包、事务日志、隔离目录与墓碑；
- `workspace/business/agents/<agentId>/extensions/mcp/servers.json`：schemaVersion 1 MCP 描述符索引，只保存受限命令、可审计参数和 `envKeys` 引用，不保存环境变量值；
- `workspace/business/agents/<agentId>/`：Agent 人格、`selfie_prompt_rewrite.json`、可选 `system-prompts/` 覆盖、自拍参考图、私有数据和人工维护文件；
- `workspace/business/agents/<agentId>/{workbench,docker-workbench}/knowledge/`：当前 Agent 的两套独立人工知识资料树；管理 API 以 `workbench=native|docker` 选择目标，运行时递归读取 JSONL、Markdown 与文本普通文件，并把各自文件清单原子发布为同目录 `index.json`。资料是用户维护的源文件，不是会话或系统增长日志，不能跨 Agent 读取，也不进入 Git；
- `workspace/cache/knowledge/<agentId>.sqlite` 与 `<agentId>-docker.sqlite`：分别从 Native 与 Docker 资料树重建的 FTS5/BM25 索引缓存，不属于业务主库、queue 或离线恢复点；删除缓存后必须能从对应资料树完整重建；
- `workspace/business/agents/<agentId>/{workbench,docker-workbench}/selfie/references.jsonl`：当前 Agent 的两套独立 schemaVersion 1 自拍素材清单，每套每行严格保存一项 `{schemaVersion,id,fileName,note}`，最多 9 项；`id` 是图片内容 SHA-256，`note` 必填并限制为 1—120 个 Unicode code point，空文件或单个结尾换行表示空图库。清单使用同目录 0600 临时文件原子替换，拒绝额外字段、重复 ID、未知 schema、非法 Unicode、控制字符、超量内容及符号链接。升级先在旧目录完成 `references.json` 到 JSONL 的原子迁移，再由 `npm run migrate:agent-resources` 把完整目录迁入 Native workbench并为 Docker Workbench 创建独立空入口；图片仍是单张最多 8 MiB 的普通文件，清单属于小型可审阅配置，不替代 SQLite 承载增长型业务数据；
- `0.1.0` 或 `0.1.1` 到 `0.1.2` 的版本升级通过 `npm run upgrade:0.1.2 -- plan|apply` 完成；`apply` 必须先停止统一运行时并创建覆盖全部 Agent 业务库和 queue 的离线恢复点，再显式迁移全部 Agent 的表情与自拍 JSONL 及双工作区布局，启动后以 status 与 doctor 收口。表情旧 SQLite 行只允许在 `workbench/emoji/emojis.jsonl` 原子发布并复读成功后清除，升级恢复点是表情迁移的回滚来源；资源迁移必须把 Agent 根、双工作区和受控资源目录收紧为当前运行用户拥有的 0700，把固定管理入口收紧为 0600，已有 marker 的重复 apply 仍需幂等修复权限漂移，verify 对宽权限、错误属主、链接或特殊文件失败关闭；
- `0.1.2` 到 `0.1.3` 通过 `npm run upgrade:0.1.3 -- plan|apply` 完成；没有 SQLite schema 或资源布局迁移，`apply` 仍固定停服并创建全 Agent 双库恢复点，再启动全部 Agent运行保留式提示词迁移，当前合同收敛到 `conversation-chat-media-v4`，最后执行 status 与 doctor。plan 必须零写入；提示词首次迁移由 registry 创建一次 0600 备份和 journal，已完成 marker 后不回填管理员修改；
- `workspace/business/agents/<agentId>/voice/profile.json`：当前 Agent 的 schemaVersion 1 Voice Profile，小型可审阅配置保存启用状态、默认语言、OpenAI Audio 兼容协议、无凭据 Base URL、API Key 环境变量名、模型、`zh`、`en`、`ja` 三个音色 ID 和三个可选音色资料元数据槽位；资料项绑定安全文件名、受控相对路径、MIME、字节数、SHA-256、台词、更新时间和可选 HTTPS 来源，不保存音频字节、API Key 值、模型权重或绝对路径；
- `workspace/business/agents/<agentId>/voice/references/`：当前 Agent 的本地参考音频，文件名按内容摘要固定，单文件最多 8 MiB，发布与读取均拒绝符号链接、目录替换、非法父链和元数据漂移。Kivo 下载器只把小春、普拉娜、阿罗娜的日语参考音频写入对应本机 Agent workspace，并把来源 URL 留在 Profile；参考音频、Kivo 下载结果和 Profile 都属于终端本地资产，不进入 Git，也不包含在 Agent 配置文件夹导入白名单中；
- `workspace/business/agents/<agentId>/workbench/`：当前 Agent 的文件工具私有目录；初始化时 write-if-missing 创建 `index.md`，已有管理员内容不覆盖。目录内容不会自动进入模型请求，只有经过管理员私聊能力门禁和逐次路径、身份、类型及大小复验的文本文件可以按请求读取或原子写入；
- `workspace/business/agents/<agentId>/workbench/chat-media-<sha256>.<ext>`：本轮受控聊天媒体的原始字节导出副本，固定为 0600 单链接普通文件；只由冻结的当前/引用媒体映射经同 Agent 缓存、摘要、MIME、扩展名、大小和 parent-inode 绑定发布，不维护增长型索引。模型不能选择文件名或目标目录，重复摘要只复用已验证文件，现有冲突文件不覆盖；
- `workspace/business/agents/<agentId>/docker-workbench/`：当前 Agent 的隔离 Bash 独立可写持久目录，也是管理员群聊与普通 QQ 会话 `send_file` 的唯一源根；以 write-if-missing 的 `index.md` 作为查询入口，并拥有独立的 `selfie/`、`emoji/`、`skills/` 与 `knowledge/` 管理入口。运行时把完整 Native `workbench/` 只读投影到该容器的 `/workbench/native-workbench/`，Docker Bash 可以使用出站网络获取完成高层级任务所需的公开文件；
- `workspace/business/agents/<agentId>/workbench/skills/` 与 `extensions/mcp/`：隔离 Bash 继续通过 `/skills` 与 `/mcp/` 读取共享配置；完整 Native workbench 同时只读映射为 `/workbench/native-workbench/`。Docker 命令不能修改其中自拍、表情、Skills、知识库或其他文件；
- `workspace/business/agents/<agentId>/workbench/.voice-cache/`：当前 Agent 的可重建合成 WAV 缓存，文件名固定为 `voice-<sha256>.wav`、单文件最多 32 MiB；只有经过在线响应大小、WAV 结构与摘要校验的字节可以发布，随后仍须通过 `conversation_asset` 文件身份和摘要门禁进入 durable outbox。该缓存不进入 SQLite 或 Git，删除后只影响尚未读取该文件的待发送语音，不能作为长期历史或音色资料来源；
- Bash backend 不再是可修改偏好；单调配置 epoch、审批结果、独立 Provider 实例、abort signal、审批票据与 capability 快照不持久化。管理员 QQ 私聊与已认证管理员 Web Chat 可取得 Native 和 Docker 两个独立工具，其他 QQ 会话只取得 Docker；每条命令先交给同一独立对抗审批合同，票据额外绑定 backend。Docker 不能申请可写 workbench 外部路径、宿主 Bash 或 Docker socket；只允许为合法高层级任务执行无凭据 HTTP(S) 获取，上传、本地文件外发、私网/元数据地址和代理改写由审计拒绝。缺字段、过期、重放或绑定不一致均拒绝；
- macOS Native Docker Bash 的容器身份只写入 Docker labels，不新增业务持久化：稳定部署字段使用 `io.sunabot.runtime-id`、`io.sunabot.workspace-id` 与 `io.sunabot.component=workspace-bash`，单次 Core 和调用字段使用随机 `io.sunabot.owner-id`、`io.sunabot.invocation-id` 与整数 `io.sunabot.expires-at-ms`。在线删除必须同时核对 owner 与 invocation；跨进程过期回收还必须核对稳定部署字段、过期时间和固定容器名，不能依据名称、路径 hash 或单个标签删除容器；
- Provider 可执行 Bash options 只能由当前真实 OneBot 入站或已认证管理员 Web Chat 即时构造，必须在同一不可变配置快照中包含 epoch、固定 backend、Native 与 Docker 两个 workbench、access mode、strict mode、宿主权威 `isAdmin`、原始 `userRequest`、独立 audit runner、`isCurrent` 和完整审批上下文。审计闭包必须覆盖调用方传入的同名身份与请求值；普通用户直接指示 Bot 操作、枚举或披露工作区时拒绝，高层级文件结果可以在 Docker workbench 内落盘。两个 workbench 的规范路径、父链和目录身份必须在审计前冻结，并在隔离 probe 与最终 spawn 前复验；Native 允许读写同 Agent 的两处 workbench，Docker 只允许写自身 workbench并只读访问 Native 投影。`isCurrent` 必须贯穿 Bash runner，并在所有文件身份 await、审批 issue/consume、隔离 probe 和最终 spawn 边界复验；旧 handle 以 `BASH_CONFIGURATION_STALE` 失败关闭且不得产生审批、探针或执行副作用。API catalog 的双环境 capability、模型返回参数和持久配置都不能单独升格为执行权限；
- `workspace/business/media/`：保存普通生成图片、持久附件和 `conversation-assets/agents/<agentId>/<sha256>.<ext>` 会话图片归档；归档只保存已经作为 workbench 参考快照、成功 `send_file` 图片读取或本轮实际命中并通过完整性校验的出站表情字节，assistant 会话消息仅持久化 `/generated-images/conversation-assets/...` URL，不保存宿主路径、Base64 或可变 workbench 定位。出站表情只有远端发送成功后才把已准备的归档 URL 写入 assistant 会话媒体；发送失败留下的未引用内容寻址文件不形成历史句柄。各 Agent 的两套表情清单与引用 PNG/GIF 分别位于 `workbench/emoji/` 与 `docker-workbench/emoji/`。完整业务恢复、跨机迁移或远程搬迁必须把两套目录作为独立资产复制并核对，缺少会话归档会使对应历史媒体句柄不可解析，缺少来源清单或任一引用文件时该项不能进入可用图库；
- `workspace/runtime/napcat/accounts/<accountId>/`：单个 QQ 的 NapCat Docker 配置、登录态、二维码、`account.env` 和运行标记；该目录只挂载给对应 NapCat 容器，不作为 Core 的媒体共享目录；
- `workspace/runtime/napcat/accounts/<accountId>/manual-login-required`：用户从管理台退出该 QQ 后的临时标记；对应 NapCat 重启时据此跳过快速登录，扫码成功后自动删除；
- `workspace/cache/`：可重建缓存，不进入快照；
- Agent 人格、公共系统提示词和 Agent 系统提示词覆盖：需要人工审阅和管理台编辑；
- 单个附件 manifest、好友/群目录缓存：体积小且可重建；
- 图片与文档二进制：文件系统更适合流式访问；
- Codex JSONL：`exec --json` 与 `app-server --stdio` 子进程通信协议；deferred worker 只接受运行时添加的管理员授权标记，使用 `workspace-write` sandbox，隔离 Codex home 仍位于任务目录。管理员控制模式的本机线程保存在主 Codex home、远端线程保存在目标主机 Codex home。Sunabot SQLite 只保存异步 job 参数、冻结输入的相对路径/摘要/大小/文本投影元数据、终态、回调和运行中进程身份，不复制附件正文、原件字节、宿主路径、授权文件或 Codex 会话历史。产物声明只能落在当前 claim 的 exact attempt-token `outputs/`，`codex-home`、workspace、result/schema、输入和其他 attempt 目录都不能注册为产物；完成回调在 durable 终态提交前持有可回滚发布，提交后才解除补偿。rename 已落盘但 worker 响应丢失时，只在源消失、目标仍为同一 dev/ino 且绑定父目录身份未变时恢复发布所有权，使后续失败仍能补偿删除。旧 job 没有产物声明时保留原终态；出现产物声明但缺少冻结 Workbench backend 时以 `codex_artifact_backend_missing` 失败，不能猜测目标或静默丢弃文件。`analysis` 与 `research` 只取得受控文本投影并关闭 shell；`local` worker 可读冻结原件，并因 attempt 内认证材料而属于管理员授权的受信任执行主体。当前输出白名单与路径脱敏不构成对恶意附件提示注入后凭据转写的硬隔离；把 `local` worker 作为不受信任主体前，必须引入进程外短期认证或等价凭据代理。
- 表情 JSONL：只允许上述 64 key × 20 版本、2 MiB 上限的有界目录清单，不得复用于会话、消息、记忆、任务、日志或历史索引。

Bot 可见配置目录只认一个权威管理入口：workbench 使用 `index.md`，Skill 使用 `index.json`，MCP 使用 `servers.json`，自拍使用 `references.jsonl`，表情使用 `emojis.jsonl`，知识库使用 `index.json`。已有专用清单的目录不能再生成第二份通用索引；管理后台和 Bot Bash 必须读取同一入口，入口缺失、未知 schema、损坏或引用不存在时失败关闭。

Agent 扩展存储、API、Provider 和运行时已由 W2 组合根接线。跨操作缓存的 Workspace 根身份绑定规范 realpath、dev 与 inode；根目录内容正常变化时刷新 ctime，根目录本身被替换或改为链接时仍失败关闭。单次操作继续固定 Workspace、Agent 与受控扩展目录身份，Skill、MCP 或 Workbench 目录在操作期间变化时拒绝继续。Skill ZIP 只接受普通文件和目录，限制归档、条目、单文件、总展开体积、压缩比与深度，拒绝链接、设备、FIFO、路径穿越和跨平台冲突名称；单层包装目录在暂存时规范化为包根，索引以内容摘要、批准摘要和 revision 绑定已安装目录。跨 Agent 迁移执行复制、重新校验和原子发布，不跟随 symlink、不共享 inode、不复制秘密或 OAuth token。MCP 描述符只允许受限容器绝对可执行路径、可审计参数和 `/workbench` 虚拟路径，逐段检查可执行文件名与参数中的嵌入值，拒绝 C0/C1 控制字符、非法 Unicode、Unix/Windows/UNC/`file:` 宿主路径、超过有界解码深度的输入、重复 percent/Base64 编码秘密及长 hex、base32、高熵或低字符类不透明值；stdio 描述符只持久化逻辑 `envKeys`，overview 与复制预览只返回按 Agent、server 与逻辑 key 派生的实际宿主环境变量名及 configured/missing 状态，不接收、返回或跨 Agent 复制秘密值，目标 Agent 会得到不同变量名并默认 missing。

跨 Agent apply 在目标 `workbench/skills/` 内先持久化 0600 复制事务日志及源包、旧目标包 sidecar，再按 Skill index revision 和每步 MCP index revision 执行 CAS。复制、恢复和全部 Skill/MCP 管理写共用目标 Agent 的 `.copy.lock`；进程内 owner 通过异步上下文只授权当前 copy 的嵌套写，其他同 Store 或跨 Store 写入在首个副作用前返回 busy。同一 Store、同一 Agent 的并发布局检查共享正在执行的 `ensureLayout`，避免普通消息回合在只读扩展准备期间彼此触发 busy；真实管理写入的冲突合同不变。日志绑定 preview 摘要、源/目标四份 revision、复制策略、目标安全 MCP after-index、Skill before/after-index 及包摘要；Skill 发布、每个 MCP 写入和最终终结之间的崩溃由 `ensureLayout` 恢复为精确 all-old，已写 committed 但终态 rename 响应丢失时收敛为精确 all-new。恢复只接受每个受影响项仍等于日志中的 before 或 after，任何无关项或后续用户修改都不覆盖并返回 `AGENT_EXTENSION_COPY_RECOVERY_REQUIRED`。成功、完整回滚后 source/previous sidecar 以父 inode 绑定和精确文件身份删除，active 日志分别终结为 committed、rolled_back 审计；archive 与 journal 之间的中断残片在下一次持锁恢复时删除，archive 文件总数超过 4 视为异常。terminal 审计按 `createdAt,id` 保留最新最多 16 份且总计不超过 8 MiB，淘汰使用相同 parent-bound 删除且永不处理 active journal；畸形 terminal 保留并失败关闭。损坏或来源不明的日志、sidecar、索引顺序、摘要与 archive lineage 均失败关闭。

Skill 安全审查采用 prepare→独立 audit→commit 三阶段。prepare 在受信索引锁内绑定 Skill 根和完整普通文件 manifest，以 `O_NOFOLLOW` descriptor 逐个读取全部有界文本并复验 dev/ino/size/mtime/ctime/nlink、摘要和根身份；symlink、hardlink、设备、目录交换、未知二进制和任何 TOCTOU 变化失败关闭。audit 只收到内存中的摘要绑定副本，正文 Buffer 在成功和失败后清零且不得进入日志。commit 重新取得锁，按 index revision、内容摘要和 manifest CAS，重新验证完整包后一次原子写入 `riskEvidence.reviewStatus/reviewedDigestSha256` 与 `approval.status/digestSha256/approvedAt`。单独手改任一字段不能启用；替换产生新摘要时恢复未审查状态。旧索引缺少可选外部 origin 列表时按空列表兼容，不能因此绕过内容复验。

Skill 脚本基础模块可生成独立的一次性投影，不直接挂载 Agent extensions 源目录。投影先通过 descriptor 读取和完整包摘要复验复制当前 Skill，再写入只含 Skill ID、包摘要和目标脚本 manifest 的非秘密绑定文件；投影父目录为当前 UID 独占的 0700 私有目录，投影发布后目录为 0500、文件为 0400。root、workbench、skills、script 与 manifest 在投影完成后冻结 canonical path、dev、ino、ctime、uid、mode 和逐级路径身份，并在 spawn 前完整复验；清理先在已冻结的私有父目录中把同一根 inode 原子 rename 到随机 quarantine，再递归处理该 quarantine，根或父目录替换时不删除可见替代物，失败显式返回且可按同一 inode 重试。沙箱不读取 MCP 描述符或 credential vault，不继承宿主、代理或 MCP 环境变量；Docker Core/Native bwrap 与 macOS Host Docker 基础 invocation 只暴露 `/skills` RO、`/workbench` RO、临时 `/tmp` RW、固定虚拟环境和无网络 namespace，镜像中移除 npm/npx/corepack/pnpm/yarn/bunx/uv/uvx/pip 入口。该基础模块未接入运行时；固定可证明的单段执行模型、完整实际执行字节审计与审批闭环完成前，所有平台必须隐藏脚本 capability。

每个 stdio MCP server 启动前生成当前 Agent、当前 server 专属的 digest-pinned 投影：已批准 Skills 复制到只读 `/skills`，只含该 server 非秘密描述符的配置以只读方式挂载到 `/run/sunabot/extensions/mcp.json`，当前 Agent `workbench` 是唯一可写持久挂载。投影不包含 Agent workspace 根、HOME、其他 server、代理变量、Docker Env 或 Docker socket；server secret resolver 将 Agent、server 与描述符逻辑 key 派生为唯一宿主环境变量名，只从该物理名称读取值，再以逻辑 key 注入目标进程，禁止回退读取同名全局环境变量；`clearenv` 与固定虚拟环境再次兜底。生产 stdio 默认关闭；Docker 后端只接受包含预装 server 与批准清单的 digest 固定自定义镜像，并显式绑定该镜像内批准清单的 SHA-256；Linux/WSL bubblewrap 后端只接受绝对、root 所有、单硬链接、`0444` 的批准清单，运行时不得下载依赖。Linux/WSL 使用 bwrap、prlimit、独立 PID/用户/网络/cgroup namespace 和进程组；运行时网络固定关闭，macOS Native 缺少等价强隔离时失败关闭。进程退出、启动探针失败、禁用、Agent 关闭和 SIGKILL 清理必须先把同一目录 inode 原子移入已绑定父目录内的随机 quarantine，再覆盖并截断秘密文件；wipe 失败必须保留该 quarantine、返回稳定清理错误并允许按原 dev/ino 重试，不能以递归删除成功替代 wipe 成功。临时根包含 owner PID，启动时只清理由当前 UID 拥有且 PID 已不存在的活动投影或 identity-bound quarantine，活动或符号链接目录不处理；GC 的目录读取或身份检查除 `ENOENT` 外任何错误都失败关闭，不得继续创建新投影。

远端 MCP 仅由 Core 的受控 Streamable HTTP client 发起，不为 Bash 或 stdio 沙箱开放网络。每次连接和重定向都重新执行 HTTPS/localhost、Origin、DNS pin、私网、loopback、link-local、metadata 地址、响应大小、总时限和 redirect 上限校验，禁用宿主代理环境；Authorization、Cookie、Host、Origin、MCP session/protocol 等保留头只能由宿主管理。Bearer 环境引用绑定 Agent、server、credential reference 和规范 resource audience。OAuth access/refresh token、PKCE verifier 与 state 不写入 Agent 描述符、日志、普通 SQLite 或子进程环境；持久 vault 使用显式 32 字节主密钥和 AES-256-GCM，记录绑定 Agent、server、subject 与规范 resource，state 还绑定一次性 TTL、浏览器 session 与精确 localhost redirect URI。refresh rotation 先复验全部绑定并原子替换密文；重放、跨 Agent/server/resource/browser、非 localhost callback、token passthrough 和缺少 vault key 均失败关闭。删除 MCP server 或替换其 transport、URL、auth kind、credential reference 时，组合根必须先关闭该 Agent 的扩展运行时，再按旧 Agent/server/admin subject/resource/handle 精确撤销 OAuth 凭据，撤销成功后才以旧 index revision 执行配置 CAS；关闭或撤销失败不得修改索引，撤销后的 CAS 冲突保持旧 handle 已失效，不能恢复访问。

Agent 根目录及 `extensions`、`skills`、`mcp` 控制目录必须是当前用户拥有的 0700 单一目录对象，索引与日志为 0600。所有 mkdir、创建、原子替换、锁、暂存写入、发布、隔离、墓碑和目录同步都通过绝对 `process.execPath` 启动的固定无 shell 子进程完成，子进程环境为空、工作目录固定为已验证父目录；ready 握手复核启动 realpath 与 bigint dev/ino/ctime，执行前和完成后以 dev/ino 复核 cwd，最终操作数只使用 NFC 安全 basename。配置替换与首次创建使用父进程生成的不可预测 operation token、命令摘要、0600 intent 和新 inode evidence；mutation 前后分别 fsync，worker 在 fsync 后至 stdout 前被 SIGKILL、输出被截断或 create link 后留下 nlink=2 时，必须由新 worker 在相同父 inode 内按 token 对账，不能由父进程按可见路径回滚。配置替换先为旧 inode 建立同目录保留链接，再以同目录 rename 发布新文件；rename、目标复验、证据复验、目录同步或响应返回失败时，只能在确认目标仍是本次新 inode 后恢复原 inode 或原本不存在的状态，无法证明恢复结果时进入 `BOUND_RECOVERY_REQUIRED`。成功结果只有在 finalize 已清理 intent/evidence 且目标仍匹配 primary 返回 identity 后才能向调用方返回；finalize 自身丢失响应时必须由后继 worker重新证明终态。Skill 事务先写 `prepared` 日志，成功或完整回滚后转换为独立命名的 `committed` 或 `rolled_back` 终态审计；active recovery 入口固定 `skills` 的 realpath/dev/ino/ctime，并将该 lineage 传入日志替换、目录移动、bind、终态 rename 与目录同步，目录被等权限新 inode 替换时失败关闭且替换目录零写。active 的三种状态都必须按索引、目标、隔离目录或墓碑证据恢复并终态化，source 与 terminal 同时存在、同时缺失或内容冲突时进入 `SKILL_TRANSACTION_RECOVERY_REQUIRED`。损坏的历史终态审计不参与 active 恢复。隔离目录、墓碑、锁墓碑和终态日志目前没有自动 GC。

配置医生当前仅检查和修复 `workspace/business/config/sunabot.json`，不会扫描或修改 Agent `agent.json`、公共或 Agent 提示词、人格文件、`runtime.env`、管理员凭据、SQLite、NapCat 状态或其他 workspace 内容。扫描直接读取原始文件并限制为普通非符号链接、有效 UTF-8、最大 512 KiB；本地规则可清理 UTF-8 BOM、JSON 末尾逗号、已退役字段和白名单内缺失或无效的小型设置，其余语法、重复字段、根结构和受保护字段问题进入手动处理。

每次应用修复前按原始文件 SHA-256 revision 复核源版本，并与普通设置写入共用互斥锁。服务端只根据 `normalizeConfigDocument`、`defaultConfig` 和完整配置校验生成本地修复方案；缺失字段使用当前缺省值，已有非法布尔值使用 `false`，多余字段删除，不能由浏览器提交任意 patch 或目标值。服务端在 `workspace/backups/config-doctor/<repairId>/` 持久保存权限为 0600 的 `before.json` 与 schemaVersion 1 `manifest.json`，manifest 记录修复来源、前后摘要和修改路径；备份不会在成功后删除。候选配置经过完整校验、运行时预检、原子写入、写后摘要复验和重新加载后才提交热更新；若磁盘还包含方案外合法变更，修复只将方案字段合入当前活动配置，其余磁盘变更保持待加载并返回 `restartRequired: true`。持久化之后任一步失败时自动以原始字节原子恢复配置并恢复原运行配置，双重恢复失败才进入 `CONFIG_RECOVERY_REQUIRED`。当前备份用于审计和自动故障恢复，没有用户主动回滚入口。

### 8.3 旧数据迁移

`0.1.0`—`0.2.0` 老实例升级到当前 revision 时必须按目标版本逐级执行版本专用脚本；每个脚本只允许在对应目标版本的完整代码包中运行，不能跳过中间版本或通过修改版本文件绕过 `TARGET_RELEASE_MISMATCH`。达到 `0.2.0` 后，切换当前批准 revision，保持停服创建并验证新的全 Agent SQLite 恢复点，执行双 Workbench 布局验证，再启动当前 schema 的前向迁移。完整路线、表情/自拍参考图/知识库双来源验收和回滚边界见 `docs/migrations/upgrade-old-versions-to-current.md`。

`npm run migrate:sqlite` 执行以下操作：

1. 确认 sunabot 服务已经停止。
2. 检查旧记忆文件事务没有未提交项。
3. 备份旧会话、记忆、调度器、请求日志、图片历史和附件分块。
4. 导入 SQLite，并逐项核对源记录数和数据库记录数。
5. checkpoint 主库。
6. 仅在全部校验通过后删除旧 JSON/JSONL 源文件。

备份保存在 `workspace/backups/sqlite-migration-<timestamp>/`，该目录不进入 Git。

旧的 `config/agents/artifacts/security/napcat/.env` 布局必须在服务停止后通过 `npm run workspace:migrate` 前向迁移。迁移器先 checkpoint 和校验 SQLite，检查目标冲突，生成带 SHA-256 manifest 的业务数据备份，再移动到 `business/runtime/secrets/cache` 边界；不会覆盖内容不同的目标文件。检测到旧布局时，生产启动直接失败，不会静默创建第二套数据库。

首次启用多 Agent 时通过 `npm run migrate:multi-agent -- --workspace <绝对路径>` 执行只读预检，停服后增加 `--apply --quiesced` 完成迁移。workspace 初始化与 API 组合根在任何业务写入前校验 `business/migrations/multi-agent-v1.json`，AgentRegistry 在自身文件与注册写入前复核或接收同一组合根已经完成的校验结果。真正空目录先原子写入带完整性摘要的 `fresh-install` 标记；门禁自行创建的目录与受控临时文件可在发布中断后清理并重试，主库一旦出现，fresh 与 completed 状态都必须通过完整注册集合校验。完整集合包含规范主双库、每个 Agent 的规范 workspace 与 manifest、所有非 Plana Agent 的双库、每个 QQ 的 Agent 归属、唯一 WebUI 端口和 `config-full/qq/plugins` 目录，以及不可删除的 Plana/primary 基线与 primary `6099` 端口；所有必需路径逐段拒绝符号链接。`completed-migration` 额外核对标记中的目标 Agent workspace 和 primary WebUI 端口，后续合法新增的 Agent 与账号继续纳入集合校验。既有目录缺少标记、标记被修改、格式无效或任何注册状态漂移时，以稳定错误码拒绝启动且不补建当前结构。

迁移器在写入前检查 Native PID、配置与固定 Core/OneBot 端口、全部注册账号 WebUI 端口，以及带当前 workspace 标签的全部活动容器，包含 paused、restarting 等非停止状态；无法核对 Docker 状态时以 `RUNTIME_INSPECTION_FAILED` 停止。随后创建并复验当时注册范围内的完整 SQLite 恢复点，旧单 Agent workspace 的恢复范围是 Plana 业务库与默认队列。旧结构复制公共提示词时遇到同名不同内容会终止；已经具备完整 Plana/primary 注册、manifest 和账号运行目录的当前结构以 `business/prompts/` 为公共提示词真值，封存缺失标记时保留现有公共版本。缺少公共提示词时，迁移器在生产初始化前显式补齐；旧版仅有 `conversation_reply.json` 时，缺少的私聊与群聊回复提示词都从该文件继承。迁移报告分别记录 `copiedRuntimeEntries`、`preservedRuntimeDivergences`、`copiedSystemPrompts` 和 `preservedSystemPromptDivergences`，保留差异同时记录旧源与当前目标哈希，并在 apply 后复验目标未被覆盖。

完成迁移后先落盘报告，再写入包含恢复点 ID、恢复 manifest SHA-256、报告 SHA-256、源状态 SHA-256、目标 workspace 与注册信息的 `completed-migration` 标记；写标记前后都执行完整集合校验。结构已经就绪但没有标记的 workspace 也必须停服并重新创建恢复点后才能封存。迁移器逐表记录旧业务数据数量；现有业务数据继续归属 Plana，规范主库和默认队列路径不移动。旧 `NAPCAT_ACCOUNT` 回填到 primary 的 `agent_accounts.qq_id` 和账号 `account.env`；旧 `workspace/runtime/napcat/config-full`、`qq`、插件、二维码和登录标记只做无覆盖复制到 `workspace/runtime/napcat/accounts/primary/`，不删除旧文件。QQ 身份或目标内容冲突、记录数变化、SQLite 完整性、外键或文件哈希校验失败时禁止启动。源码仓库中的迁移命令先构建 API。Linux 发行只允许从干净且构建期间 revision 不变的 Git 工作树创建，并强制重新执行生产构建；无 Git 发行包的 schema v2 manifest 绑定 runtime contract、版本、Node、source commit、真实 Linux/x64 平台，以及完整 `dist/`、`tooling/`、生产 `node_modules/` 和根目录/安装依赖锁文件的 SHA-256，迁移 wrapper 在执行前复算文件集合与哈希，不依赖开发依赖。npm 生成且迁移不会执行的 `.bin` 命令链接不进入清单，其他符号链接全部拒绝。完整执行与回滚步骤见 `docs/migrations/single-agent-to-multi-agent.md`。新增 Agent 必须先原子创建完整 workspace 与 manifest，再登记数据库；运行时初始化失败时补偿删除注册记录和刚创建的 workspace。

### 8.4 日常导演 schema v14

业务 schema v14 引入 `director_daily_schedules`、`director_daily_schedule_revisions` 与 `director_schedule_task_links` 三个 STRICT 表。current 表以 `schedule_date` 为主键保存当天最新 revision、IANA 时区、种子 SHA-256、完整行程 JSON 和生成/更新时间；revision 表以日期与 revision 为复合主键，追加保存来源、角色请求、种子摘要、完整快照和创建时间；task link 以定时任务 ID 为主键关联日期、revision、item、runAt 与创建时间。行程与 revision 属于增长型业务数据，必须留在每个 Agent 的 `sunabot.sqlite`，不得写入 JSON/JSONL。

导演总开关保存为每个 Agent manifest 的 `bot.director.enabled`，缺失时默认关闭；它不是增长型业务数据，不进入 SQLite。关闭只移除尚未触发的任务与 link，不删除每日决策、revision、已终结任务或运行历史。

会话级导演事件开关随 `ConversationRecord.directorEventsEnabled` 保存在各 Agent `conversations.data_json` 中。旧记录缺字段与显式 `false` 都表示关闭，新建会话显式保存 `false`；不得通过启动迁移批量开启既有会话。该字段只控制导演主动分享目标，不复用普通回复或编排器开关。

会话级编排器时间覆盖随 `ConversationRecord.orchestratorResponseTimeOverrideEnabled` 和 `ConversationRecord.orchestratorResponseTimeMs` 保存在各 Agent `conversations.data_json` 中，不新增表或 schema 版本。旧记录缺少开关时按关闭处理，已有数值仅在开关显式为 `true` 且为 1,000—3,600,000 的整数毫秒时生效；关闭覆盖时保留合法数值，便于该会话再次开启。API 拒绝字符串、小数和越界值，运行时遇到损坏值回退到 Agent 的 `recentMessageWindowMs`。

每天首个 `daily_plan` 提交幂等返回已有快照，角色修订必须携带 expected revision 并在 `BEGIN IMMEDIATE` 事务中追加历史与更新 current；过期 revision 只能返回 conflict，不能覆盖。Director 任务 ID 由 Agent、日期、item、revision 与目标分块确定，`scheduled_tasks.create` 允许内部调用提供受校验 ID；相同 ID 与相同 draft 幂等返回，内容不同必须拒绝 collision。迁移向前创建表并把 metadata 推进到 14，既有记忆、会话、Emoji、定时任务、请求日志和 Agent 数据不变。

### 8.5 Dream schema v15

业务 schema v15 的既有 Dream 表继续前向兼容。`dream_runs` 保存自然日唯一运行、系统时区、04:00 窗口、输入摘要、三字段模型输出、租约、重试与添加结果；旧 `memory_recall_stats`、`memory_recall_receipts` 与 `dream_memory_archive` 表暂不删除，当前 Dream 管线不读取、初始化、更新、归档或清除其中数据，长期记忆遗忘功能后续单独设计。

同一 Agent、系统时区自然日的 Dream run 唯一，claim、generated、consolidated 与 completed 阶段继续受租约和条件更新保护；persona 阶段固定记为 `none`，不执行人格读写。模型输出先持久化为 generated，重启恢复直接继续提交；暂时模型或传输故障最多尝试三次、间隔 15 分钟，永久输入、长期记忆快照、结果冲突以及 Provider 明确返回的不可重试 HTTP 4xx 只尝试一次。工作记忆 CAS 与长期记忆 add-only 替换快照共享现有恢复和回滚边界，事务必须证明最终长期记忆集合包含提交前全部记录且只增加本次去重后的新记录。

调度表达式固定为系统 IANA 时区的 `0 4 * * *`，按当地自然日唯一并由时区库处理夏令时。Core 在 04:00 后启动时只补最近一次未运行日期，不遍历历史欠账；全新安装在首次 04:00 之前不会补做安装前一天。运行时每分钟检查一次，stop 会取消当前模型请求并释放定时器，完成记录不会重复执行。

## 9. 配置与安全

- Provider key、Tavily key、OneBot token 和自动化管理令牌只能通过 `workspace/secrets/runtime.env` 或进程环境变量提供。
- 新 workspace 的 `bot.adminQq` 默认为空，不内置任何真实 QQ 身份；管理员登录 QQ 后必须在对应 Agent 的“回复行为”中显式保存管理员 QQ，管理员专属工具在此之前保持关闭。
- Git 不跟踪整个 `workspace/`，其中包括环境变量、配置、Agent 人格、SQLite、WAL、日志、缓存、QQ 登录态、生成图片和备份。
- 浏览器管理台不得把账号、密码、Bearer Token 或会话密钥写入 localStorage/sessionStorage。
- 请求日志递归脱敏授权、token、password、secret 和常见 key 字段；模型 request/response payload 的单字符串上限为 8 MiB，其他日志长字符串上限为 16,000 字符。文件工具与 MCP 的参数和结果继续使用有界安全投影，原始 Provider payload 不能绕过该投影。
- WebFetch 静态抓取只允许无凭据的标准端口 HTTP(S) URL。静态请求与每次重定向解析全部 DNS 记录并拒绝私网、回环、链路本地、保留、映射与地址转换绕过，再把实际连接固定到已校验地址；DNS 使用同一总超时 signal。动态 renderer 当前只允许 HTTP 导航与 HTTP 子请求，HTTPS 在入口失败关闭且代理拒绝 CONNECT；子请求仍逐次复核 DNS 并固定地址，同时受单响应、累计响应、请求数、并发、队列和取消边界约束。系统 DNS 的全部结果仅在命中 Clash `198.18.0.0/15` Fake-IP 时通过固定 DoH 重新解析，直接输入或普通 DNS 返回该保留网段仍拒绝。响应解压后和 renderer DOM 各自受 4 MiB 上限。renderer `/render` 只接受启动器生成的 bearer token，不接收 query，不挂载 workspace、secrets、Provider key、Codex 授权、OneBot/NapCat 凭据或浏览器用户目录，不保存 Cookie，并阻断下载、WebSocket、非 GET、压缩代理响应及图片、字体、音视频资源。macOS Native Core 使用无 workspace/secret mount 的独立 Docker renderer；Linux/WSL Native renderer 使用 Bubblewrap、独立临时 HOME/cache/run，并遮蔽仓库、workspace、凭据和浏览器用户目录。Chromium sandbox、平台隔离或健康值无法验证时动态能力失败关闭，静态抓取保持可用。清理后的正文只进入 5 分钟进程内 LRU，不新增持久化格式或原始 HTML 日志。
- `system_config` 只向模型返回固定白名单内的当前 Agent 设置与状态投影，不返回密钥、环境变量名、路径、原始消息、Provider 地址或探针诊断正文。修改只对运行时重新确认的当前管理员 QQ 私聊开放；Web Chat 只读。修改 fingerprint 只保存规范化非敏感字段的 SHA-256，不保存凭据明文；模型参数和外部 API 不能写入确认 outbox 的特殊 delivery 语义。投递旁路必须同时具有 store 中可信的 released/fallback provenance 与匹配 fingerprint，只有 payload marker 或普通 outbox 状态时仍执行完整 ReplyGate 校验。
- 配置医生发送给模型的配置先按敏感键以及身份、QQ、Provider 地址、workspace、可执行文件和提示词路径脱敏；问题列表只包含本次实际校验失败的固定白名单路径和服务端固定文案，模型只能对这些路径提出 `add` 或 `replace`，不接收工具权限。服务端限制 AI 输出大小、操作数、JSON Pointer 深度和值大小，并拒绝原型污染字段、重复路径和越权路径；用户确认页的目标值说明由服务端生成，不采用模型理由代替实际修改内容。
- 配置医生 AI 提案只保存在进程内 10 分钟并绑定原始文件 revision；连续 AI 诊断至少间隔 10 秒。浏览器应用时只提交 proposal ID 与 source revision，不能提交或替换服务端 patch。
- OneBot、跨组件媒体和 Agent 文件写入均执行身份、大小与路径边界校验；OneBot action 不能携带 Core 或 NapCat 的绝对文件路径。
- 在线语音生产地址只接受无凭据 HTTPS，开发测试只允许回环 HTTP，均拒绝 query 与 fragment；API Key 环境变量名可以保存，值只从 Core 环境读取，不得经 Profile、管理 API、浏览器、提示词、模型参数、请求日志或 OneBot payload 暴露。模型与音色 ID使用受限字符集合；资料来源字段只接受无凭据 HTTPS URL。合成错误日志只记录稳定错误码、语言、字符数、耗时、输出字节数和摘要，不记录正文、音频、API Key、供应商响应或宿主路径。
- `read_file` 与 `write_file` 只接受真实 OneBot 管理员私聊且 `promptOverride` 未设置的当前 Agent 入站消息。能力判断在创建 workbench 或解析文件之前完成；普通用户、群聊、Web Chat、伪造 Function Call 和缺失运行端口均失败关闭。Provider 在调用运行端口前按封闭字段集合复验参数并重建请求；成功结果必须使用封闭结构，绑定原请求路径与正文 UTF-8 大小，读取正文还要通过同一 Unicode/控制字符合同，不能信任端口返回的额外路径、正文或错误文本。
- Node.js 在 macOS 与 Linux 上没有可移植的文件描述符定向 rename/link 发布接口，因此最终临时文件复验与路径发布之间仍以运行 Core 的同一宿主 UID 为受信边界。测试 hook 必须全部位于最终复验之前并被确定性拦截；外部同 UID 在最终复验后主动改写路径属于受信运维主体越界，能力不声称消除该窗口。发布后仍复验目标身份和内容，发现变化时失败关闭。
