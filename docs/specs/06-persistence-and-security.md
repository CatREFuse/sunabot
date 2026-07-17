# 持久化、迁移与安全

[返回当前系统规范索引](./index.md)

## 8. SQLite 持久化

### 8.1 注册主库与 Agent 业务库

注册主库与默认 Plana Agent 业务库固定为 `workspace/business/data/sunabot.sqlite`，默认队列库固定为 `workspace/business/data/session-queue.sqlite`；外部主库覆盖已经退役，进程环境或 `workspace/secrets/runtime.env` 中出现 `SUNABOT_DATABASE_PATH` 时，launcher、doctor、API 和多 Agent 迁移器都会明确拒绝运行，其中 doctor 返回 `DATABASE_PATH_OVERRIDE_UNSUPPORTED`，迁移器返回 `CUSTOM_DATABASE_PATH_UNSUPPORTED`。其他 Agent 的业务库路径是 `workspace/business/agents/<agentId>/data/sunabot.sqlite`。各数据库使用相同的向前迁移 schema；Agent 注册表和管理员会话只以注册主库为准，其他业务表只读写所属 Agent 的数据，门禁、备份与恢复始终引用规范路径。

主库启用 WAL、`synchronous=NORMAL`、外键和 5 秒 busy timeout。当前表如下：

| 表 | 数据 |
| --- | --- |
| `app_metadata` | schema 与旧数据导入标记 |
| `agents` | Agent ID、名称、启用状态、workspace 与头像路径 |
| `agent_accounts` | QQ 接入账号、所属 Agent、QQ 号、启用状态与独立 WebUI 端口 |
| `conversations` | 会话及其消息数组，每个会话一行 |
| `conversation_thread_states` | 群聊 Thread 增量状态、处理游标、模型和提示词 revision，每个会话至多一行 |
| `memory_records` | 工作记忆、长期记忆和用户画像 |
| `memory_batches` | 已提交记忆批次及幂等结果 |
| `memory_scheduler` | 各会话的记忆待处理队列与重试状态 |
| `request_logs` | 脱敏后的模型、工具和运行日志；保留原始 usage 与统一 `tokenUsage` |
| `model_call_aggregates` | 当前 Agent 按会话与行为聚合的模型调用总量 |
| `model_call_model_aggregates` | 当前 Agent 按会话、模型、行为和记忆类型聚合的调用总量 |
| `image_history` | 生成图片历史元数据 |
| `admin_sessions` | 管理 Cookie 哈希、CSRF Token、访问时间与有效期 |

当前业务主库 schema 版本是 10。`conversation_thread_states` 使用 STRICT 表和 `conversations.id` 外键，删除会话时级联删除 Thread 状态；`state_schema_version` 当前为 1。写入以 revision CAS、单调 `processed_through_sequence` 和 `last_run_key` 幂等约束防止旧快照覆盖新状态，读取和写入都执行完整领域结构校验。message assignment、Thread message ID 和已无保留消息的非活动 Thread 随 `conversations` 的消息保留边界清理，单 Thread participant uid 最多保留 256 个；原始会话消息不由 Thread 节点删除。模型输出、提示词和运行时错误不能回退游标或破坏已提交状态；Thread 状态仍属于业务库恢复范围，不新增 JSON/JSONL 增长型持久化。异步 Thread 快照读取时复核字符串长度、稳定 Thread ID、active/primary/related 引用、唯一性、sequence 和提示词容量边界；损坏或旧格式快照降级为空 sidecar。恢复门禁只允许 `app_metadata.storage-schema-version=9` 的旧 current 恢复点缺少该表，并在恢复时复核实际数据库版本；schema 10 缺表继续判定为不完整。

Plana 的 `workspace/business/data/session-queue.sqlite` 与其他 Agent 的 `workspace/business/agents/<agentId>/data/session-queue.sqlite` 分别保存所属 Agent 的会话事件、turn、异步任务和 outbox。当前 session queue schema 版本是 5；outbox 的 `hold_state`、`mutation_fingerprint`、`hold_provenance_json` 与 `release_provenance_json` 共同保存 `system_config` held confirmation，旧行向前迁移为 `hold_state=none`。fingerprint 只接受固定长度的小写 SHA-256；两份 provenance 使用版本化、有界、严格字段结构，状态与空值组合由 SQLite CHECK 和读取 decoder 双重校验。held append、release、中性化、origin turn/event 终结与恢复均使用事务，不能出现可 claim 的普通行到 held 行更新窗口。带构造期 lease 恢复的 SessionStore 必须同时注入 ReplyGate resolver；恢复遇到 held 行但缺失 resolver 时关闭数据库并失败，不能静默保留 running turn。附件缓存中的每个 `chunks.sqlite` 独立保存该文件的文本分块。

离线 SQLite 恢复点必须覆盖默认 Plana 与注册表中全部启用或停用 Agent 的业务库和队列库。创建恢复点时以注册主库和 `business/agents/<agentId>/data` 文件系统扫描结果的并集核对范围；注册 Agent 缺少数据库、单边数据库、未注册 Agent 孤儿库、非法 ID 或越界路径时失败。新恢复点使用 manifest v2，按 Agent 保存业务库与 queue 的 schema profile、校验信息和投递不变量；正常 v2 业务库必须包含当前统计、管理员会话和 Agent 注册表。校验时 manifest Agent 集合必须与备份内 Plana 注册表完全一致，恢复只接受完全空的目标 workspace，并由 manifest 清单安全重建嵌套目录。仅当 `agents`、`agent_accounts`、`agent.json` 和二级 Agent 数据库都不存在时，迁移前数据库才使用旧单 Agent schema profile。旧 manifest v1 仍可校验和恢复，范围仅包含默认 Plana 双库。

旧数据迁移按幂等键集合验证来源、导入前、导入后和真实增量，不能用总数相同替代记录身份一致。workspace 布局迁移和恢复先持久化 fsync journal intent，再逐文件记录复制、替换与完成状态；中断后可以继续或回滚，删除目标前必须复验类型、大小和 SHA-256，未知替换保持原样并失败关闭。数据库迁移在 checkpoint 后持有独占锁，活动写事务停止迁移。恢复、演练、保留清理和 stale partial 清理对绝对路径完整父链逐级检查，仅允许 macOS 根级 `/tmp` 与 `/var` 指向系统 canonical 目录的受控别名。

### 8.2 文件边界

以下内容继续使用文件：

- `workspace/secrets/runtime.env`：本机凭据，不进入 Git；
- `workspace/business/config/sunabot.json`：schemaVersion 1 的模型、正常回复重试、共用开关和默认 Plana 配置，不保存明文密钥；缺失的小型允许字段由配置归一化与配置医生规则补齐，不支持的显式 schemaVersion 失败关闭；
- `workspace/business/migrations/multi-agent-v1.json`：首次安装或单 Agent 迁移完成标记，保存完整性摘要和迁移证据摘要；
- `workspace/business/prompts/`：所有 Agent 默认使用的公共系统提示词；
- `workspace/business/agents/<agentId>/agent.json`：Agent 名称、启用状态、系统提示词覆盖开关、Bot 行为、工具覆盖、管理员私聊 Bash backend 偏好与 OneBot 行为配置；
- `workspace/business/agents/<agentId>/extensions/skills/`：schemaVersion 1 Skill 索引、已验证 Skill 包、事务日志、隔离目录与墓碑；
- `workspace/business/agents/<agentId>/extensions/mcp/servers.json`：schemaVersion 1 MCP 描述符索引，只保存受限命令、可审计参数和 `envKeys` 引用，不保存环境变量值；
- `workspace/business/agents/<agentId>/`：Agent 人格、`selfie_prompt_rewrite.json`、可选 `system-prompts/` 覆盖、自拍参考图、私有数据和人工维护文件；
- `workspace/business/agents/<agentId>/workbench/`：当前 Agent 的文件工具与 Bash 共用私有目录；内容不会自动进入模型请求，只有经过管理员私聊能力门禁和逐次路径、身份、类型及大小复验的文本文件可以按请求读取或原子写入；
- Bash backend 只在当前 Agent 配置中持久化 `native`/`docker` 偏好；单调配置 epoch、审计结果、独立 Provider 实例、abort signal、审批票据与 capability 快照不持久化。一次性审批只在进程内保存并绑定 Agent、Bot 账号、transport、完整会话、用户、可选群号、命令摘要和精确只读外部文件身份；缺字段、过期、重放或绑定不一致均拒绝；
- Provider 可执行 Bash options 只能由当前真实 OneBot 入站即时构造，必须在同一不可变配置快照中包含 epoch、backend、workbench、access mode、strict mode、独立 audit runner、`isCurrent` 和完整审批上下文。`isCurrent` 必须贯穿 Bash runner，并在所有文件身份 await、审批 issue/consume、隔离 probe 和最终 spawn 边界复验；旧 handle 以 `BASH_CONFIGURATION_STALE` 失败关闭且不得产生审批、探针或执行副作用。API catalog 的布尔 capability、模型返回参数和持久配置都不能单独升格为执行权限；
- `workspace/business/media/`：需要随业务恢复的图片和持久附件；
- `workspace/runtime/napcat/accounts/<accountId>/`：单个 QQ 的 NapCat Docker 配置、登录态、二维码、`account.env` 和运行标记；该目录只挂载给对应 NapCat 容器，不作为 Core 的媒体共享目录；
- `workspace/runtime/napcat/accounts/<accountId>/manual-login-required`：用户从管理台退出该 QQ 后的临时标记；对应 NapCat 重启时据此跳过快速登录，扫码成功后自动删除；
- `workspace/cache/`：可重建缓存，不进入快照；
- Agent 人格、公共系统提示词和 Agent 系统提示词覆盖：需要人工审阅和管理台编辑；
- 单个附件 manifest、好友/群目录缓存：体积小且可重建；
- 图片与文档二进制：文件系统更适合流式访问；
- Codex JSONL：子进程通信协议，不是持久化引擎。

Agent 扩展存储当前是未接入 API 组合根的 W1 基础层。Skill ZIP 只接受普通文件和目录，限制归档、条目、单文件、总展开体积、压缩比与深度，拒绝链接、设备、FIFO、路径穿越和跨平台冲突名称；单层包装目录在暂存时规范化为包根，索引以内容摘要和 revision 绑定已安装目录。MCP 描述符只允许受限容器绝对可执行路径、可审计参数和 `/workbench` 虚拟路径，逐段检查可执行文件名与参数中的嵌入值，拒绝 C0/C1 控制字符、非法 Unicode、Unix/Windows/UNC/`file:` 宿主路径、超过有界解码深度的输入、重复 percent/Base64 编码秘密及长 hex、base32、高熵或低字符类不透明值；overview 与复制预览只返回 `envKeys` 的 configured/missing 状态，不接收或返回秘密值。

Agent 根目录及 `extensions`、`skills`、`mcp` 控制目录必须是当前用户拥有的 0700 单一目录对象，索引与日志为 0600。所有 mkdir、创建、原子替换、锁、暂存写入、发布、隔离、墓碑和目录同步都通过绝对 `process.execPath` 启动的固定无 shell 子进程完成，子进程环境为空、工作目录固定为已验证父目录；ready 握手复核启动 realpath 与 bigint dev/ino/ctime，执行前和完成后以 dev/ino 复核 cwd，最终操作数只使用 NFC 安全 basename。配置替换与首次创建使用父进程生成的不可预测 operation token、命令摘要、0600 intent 和新 inode evidence；mutation 前后分别 fsync，worker 在 fsync 后至 stdout 前被 SIGKILL、输出被截断或 create link 后留下 nlink=2 时，必须由新 worker 在相同父 inode 内按 token 对账，不能由父进程按可见路径回滚。配置替换先为旧 inode 建立同目录保留链接，再以同目录 rename 发布新文件；rename、目标复验、证据复验、目录同步或响应返回失败时，只能在确认目标仍是本次新 inode 后恢复原 inode 或原本不存在的状态，无法证明恢复结果时进入 `BOUND_RECOVERY_REQUIRED`。成功结果只有在 finalize 已清理 intent/evidence 且目标仍匹配 primary 返回 identity 后才能向调用方返回；finalize 自身丢失响应时必须由后继 worker重新证明终态。Skill 事务先写 `prepared` 日志，成功或完整回滚后转换为独立命名的 `committed` 或 `rolled_back` 终态审计；active recovery 入口固定 `skills` 的 realpath/dev/ino/ctime，并将该 lineage 传入日志替换、目录移动、bind、终态 rename 与目录同步，目录被等权限新 inode 替换时失败关闭且替换目录零写。active 的三种状态都必须按索引、目标、隔离目录或墓碑证据恢复并终态化，source 与 terminal 同时存在、同时缺失或内容冲突时进入 `SKILL_TRANSACTION_RECOVERY_REQUIRED`。损坏的历史终态审计不参与 active 恢复。隔离目录、墓碑、锁墓碑和终态日志目前没有自动 GC。

配置医生当前仅检查和修复 `workspace/business/config/sunabot.json`，不会扫描或修改 Agent `agent.json`、公共或 Agent 提示词、人格文件、`runtime.env`、管理员凭据、SQLite、NapCat 状态或其他 workspace 内容。扫描直接读取原始文件并限制为普通非符号链接、有效 UTF-8、最大 512 KiB；本地规则可清理 UTF-8 BOM、JSON 末尾逗号、已退役字段和白名单内缺失或无效的小型设置，其余语法、重复字段、根结构和受保护字段问题进入手动处理。

每次应用修复前按原始文件 SHA-256 revision 复核源版本，并与普通设置写入共用互斥锁。服务端在 `workspace/backups/config-doctor/<repairId>/` 持久保存权限为 0600 的 `before.json` 与 schemaVersion 1 `manifest.json`，manifest 记录修复来源、前后摘要和修改路径；备份不会在成功后删除。候选配置经过完整校验、运行时预检、原子写入、写后摘要复验和重新加载后才提交热更新；若磁盘还包含方案外合法变更，修复只将方案字段合入当前活动配置，其余磁盘变更保持待加载并返回 `restartRequired: true`。持久化之后任一步失败时自动以原始字节原子恢复配置并恢复原运行配置，双重恢复失败才进入 `CONFIG_RECOVERY_REQUIRED`。当前备份用于审计和自动故障恢复，没有用户主动回滚入口。

### 8.3 旧数据迁移

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

## 9. 配置与安全

- Provider key、Tavily key、OneBot token 和自动化管理令牌只能通过 `workspace/secrets/runtime.env` 或进程环境变量提供。
- 新 workspace 的 `bot.adminQq` 默认为空，不内置任何真实 QQ 身份；管理员登录 QQ 后必须在对应 Agent 的“回复行为”中显式保存管理员 QQ，管理员专属工具在此之前保持关闭。
- Git 不跟踪整个 `workspace/`，其中包括环境变量、配置、Agent 人格、SQLite、WAL、日志、缓存、QQ 登录态、生成图片和备份。
- 浏览器管理台不得把账号、密码、Bearer Token 或会话密钥写入 localStorage/sessionStorage。
- 请求日志递归脱敏授权、token、password、secret 和常见 key 字段，并限制长字符串。
- `system_config` 只向模型返回固定白名单内的当前 Agent 设置与状态投影，不返回密钥、环境变量名、路径、原始消息、Provider 地址或探针诊断正文。修改只对运行时重新确认的当前管理员 QQ 私聊开放；Web Chat 只读。修改 fingerprint 只保存规范化非敏感字段的 SHA-256，不保存凭据明文；模型参数和外部 API 不能写入确认 outbox 的特殊 delivery 语义。投递旁路必须同时具有 store 中可信的 released/fallback provenance 与匹配 fingerprint，只有 payload marker 或普通 outbox 状态时仍执行完整 ReplyGate 校验。
- 配置医生发送给模型的配置先按敏感键以及身份、QQ、Provider 地址、workspace、可执行文件和提示词路径脱敏；问题列表只包含本次实际校验失败的固定白名单路径和服务端固定文案，模型只能对这些路径提出 `add` 或 `replace`，不接收工具权限。服务端限制 AI 输出大小、操作数、JSON Pointer 深度和值大小，并拒绝原型污染字段、重复路径和越权路径；用户确认页的目标值说明由服务端生成，不采用模型理由代替实际修改内容。
- 配置医生 AI 提案只保存在进程内 10 分钟并绑定原始文件 revision；连续 AI 诊断至少间隔 10 秒。浏览器应用时只提交 proposal ID 与 source revision，不能提交或替换服务端 patch。
- OneBot、跨组件媒体和 Agent 文件写入均执行身份、大小与路径边界校验；OneBot action 不能携带 Core 或 NapCat 的绝对文件路径。
- `read_file` 与 `write_file` 只接受真实 OneBot 管理员私聊且 `promptOverride` 未设置的当前 Agent 入站消息。能力判断在创建 workbench 或解析文件之前完成；普通用户、群聊、Web Chat、伪造 Function Call 和缺失运行端口均失败关闭。Provider 在调用运行端口前按封闭字段集合复验参数并重建请求；成功结果必须使用封闭结构，绑定原请求路径与正文 UTF-8 大小，读取正文还要通过同一 Unicode/控制字符合同，不能信任端口返回的额外路径、正文或错误文本。
- Node.js 在 macOS 与 Linux 上没有可移植的文件描述符定向 rename/link 发布接口，因此最终临时文件复验与路径发布之间仍以运行 Core 的同一宿主 UID 为受信边界。测试 hook 必须全部位于最终复验之前并被确定性拦截；外部同 UID 在最终复验后主动改写路径属于受信运维主体越界，能力不声称消除该窗口。发布后仍复验目标身份和内容，发现变化时失败关闭。
