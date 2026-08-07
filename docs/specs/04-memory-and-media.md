# 记忆、文件与图片

[返回当前系统规范索引](./index.md)

## 5. 记忆系统

### 5.1 数据边界

| 来源     | 内容                                                   | 主键和更新方式                                        |
| -------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件           | 每 Agent 一份 `WORKING_MEMORY.md`；稳定 ID；revision CAS 与原子替换 |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件                 | event key 与 fingerprint 合并；保留来源工作记忆 ID    |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和称呼数组 | 当前发言人 QQ 聚合；`add_user_profile` 完整替换 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆保存在当前 Agent workspace 的 `WORKING_MEMORY.md`，长期记忆和用户画像继续保存在当前 Agent 的 SQLite。主对话新增事实只有两个同步入口：`add_workmemory` 追加工作记忆，`add_user_profile` 替换当前发言人的聚合画像；消息入站、回复完成、外发成功、群聊锚点、定时任务和服务生命周期都不会把消息排入记忆批次，也不会另起 Provider 任务写入这两类来源。

`add_workmemory` 正文采用当前 Agent 的第一视角：在输入有依据时把时间、地点或会话场域、人物、事件经过、变化、结果与角色感受自然融进同一段，不机械补齐缺失要素。宿主不使用固定句首、称呼、QQ、关键词、情绪或表达格式正则拒绝或改写正文；内容仍必须有聊天事实、既有关系或角色人格依据，不能虚构经历或强烈情绪。

工作记忆只保留模型认为仍会影响后续回复的概括信息，`record` 每次追加一项，宿主不执行消息累计、批量重写、自动合并、语义裁剪或自动晋升长期记忆。每位用户只保留一条画像记录；`add_user_profile record` 必须返回该用户的完整更新画像和完整有效称呼数组，正文通常只含最影响未来相处的稳定认知。更新画像时可以在当前证据支持下补充、纠正或移除旧信息，不能保存一次性事件、临时安排、当前任务、会话摘要、猜测、敏感推断或其他人物资料。

工作记忆正文使用自然叙述，避免列表、五要素表格、字段标签、分类标题、来源说明或压缩说明。用户画像由宿主绑定 `userId`、当前消息显示名、Agent 和会话来源，以 `addressNames` 保存去重后的有序称呼数组；第一个称呼优先。旧 `addressName`、`address_name` 与 `salutation` 在读取时继续归一化为 `addressNames`，新记录只持久化数组。模型不能提交或改绑用户 ID、显示名、Agent、会话来源、记录时间与时区。

两个工具都使用 strict schema 和一次性决定状态。`record` 成功或合法 `skip` 才完成决定；非法参数、持久化失败或重复决定返回稳定错误。生产 Session 使用 durable incoming event ID 作为 `sourceDecisionKey`：工作记忆在文件原子替换后恢复时返回原事项，用户画像在 SQLite 重放时返回原记录，不能重复新增。`memory.compress-out` 只保留为长期记忆维护兼容提示词，不触发主对话工作记忆或用户画像写入。

`WORKING_MEMORY.md` 的普通记忆可见正文只保存模型返回的自然语言原文，不由宿主插入标题、事项 ID、记录时间、会话来源、来源类型或其他字段。Dream 记忆是唯一可见标记例外：只有 `memoryKind=dream` 的条目在 Dream 原文前显示 `【梦境｜做梦时间：YYYY-MM-DD HH:mm】`，`sourceKind=dream` 和 `dreamReviewedAt` 都不能单独触发该标记；时间取本次 Dream 实际生成整理时间，旧记录缺少该时间时回落到梦境事件时间或宿主记录时间。该标记只用于工作记忆文档展示，解析后的 Dream 原文不包含标记。宿主记录时间、IANA 时区、完整会话来源 ID、scope、可用的会话标题和来源类型保存在同一文件的隐藏 metadata 与 SQLite 操作日志中；记录时间由宿主以系统 IANA 时区生成并包含当时 UTC offset。正文表达的事件时间可以保留为 `occurredAt`/`occurredEndAt`，不能替代记录时间。模型返回和 `add_workmemory` 参数都不能指定持久化记录时间、时区、Agent 或会话来源。直接编辑 Markdown 正文会保留原事项的宿主元数据，损坏的机器 metadata 使整份文档拒绝读取。

工作记忆文档最多 64 KiB，只接受普通文件并拒绝 workspace 或目标符号链接。读取使用 no-follow 文件句柄；写入使用同目录 0600 临时文件、revision CAS、内容完整回读校验与原子 rename。`add_workmemory record` 只追加本次模型返回的非空正文，宿主补充不可见的当前 Agent、会话、记录时间、来源 metadata 与 `sourceDecisionKey`，不增加可见结构，不执行分类、标题化、改写、合并或语义裁剪。Dream 条目保持独立标记和既有 Dream 整理合同；主对话工具不能改写、删除、清空或重分类既有条目。文档超限、宿主 metadata 损坏、revision 冲突或文件安全失败时保留旧文档并让决定保持可重试。普通主回复由同一个主回复模型依次完成 `add_workmemory` 和 `add_user_profile`：前者 `record` 使用 1—4,000 字符正文、`skip` 使用 null；后者 `record` 使用 1—4,000 字符完整画像和最多 16 个称呼、`skip` 使用两个 null。宿主在每个工具执行开始时原子占用对应的 `pending` 状态，只允许一个并发调用进入写入或跳过，非法参数与写入失败释放占用供模型纠正；两项都完成前，companion、deferred、`no_reply`、其他工具和可见正文不能成为终态。

管理 API 读取单个工作记忆来源时，同时返回当前 Agent 的完整 `WORKING_MEMORY.md`、文件名和 revision；不返回宿主绝对路径。管理台以一份 Markdown 文档显示按原顺序连接的记忆正文，Dream 条目保留可见的梦境与做梦时间标记，其他条目不增加宿主标题或字段；所有事项仍不拆成管理台列表，也不显示隐藏 metadata。文档版本与事项 metadata HTML 注释只在阅读视图隐藏，API 原文和磁盘文件保持逐字一致。工作记忆页不提供逐条排序、筛选、召回、分页、新增、编辑或删除入口；长期记忆、用户画像与 Dream 的列表和操作保持各自合同。

工作记忆、长期记忆、用户画像、召回与 Dream 的操作历史统一写入当前 Agent 业务库的 `request_logs`，固定使用 `category=memory.operation`。事件只保存宿主时间、Agent、来源、操作、执行者、结果、稳定原因码、可用的 conversation/record 标识、前后数量与 revision，不保存记忆正文、画像正文、称呼值、模型原始输出、秘密或宿主绝对路径。`add_workmemory` 与 `add_user_profile` 的 `record`、`skip`、失败和未完成决定、管理员 CRUD、召回查询、pending exposure、receipt 和 Dream 阶段都必须产生对应事件；Agent 路由与业务库保持一一对应。成功业务写入之后审计追加失败不能回滚已提交的记忆，必须输出稳定的审计失败日志。该类别只记录上线后的新操作，不回填历史。

`GET /api/memory/operations?agentId=<id>&page=<n>&pageSize=<1..100>` 只从所选 Agent 业务库读取 `category=memory.operation`，按宿主时间从新到旧分页返回，不混入其他请求日志。管理台记忆页始终提供“操作日志”入口，以侧边时间线显示记忆类型、操作、执行者、结果、时间、会话来源、数量变化与原因码；batch、record 和 revision 放在可展开的技术信息中。切换 Agent 时关闭侧栏、清空旧结果并取消旧请求，迟到响应不能覆盖当前 Agent。

Dream 的工作记忆与长期记忆 canonical 继续接受 nullable `causalChainKey`，只在证据明确共享原因、转折与结果时复用 `causal:` 键。主对话的 `add_workmemory` 和 `add_user_profile` 不公开因果键、用户 ID、Agent、会话或时间字段，也不读取已停用的工作记忆压缩与用户画像提示词。升级加载旧配置或旧 prompt workspace 时忽略这些停用字段和文件，不把它们重新登记进 Prompt Catalog。

既有记忆重整时，提案提示词可以约束视角、句首、回忆提示语、直接引语、字段标签、称呼和 QQ 写法，安装器不扫描或裁决这些正文内容。signed 提案仍需绑定当前 Agent、来源行、稳定目标 ID、结构化用户 ID、数量、时间与不可变来源元数据。旧 `memory-perspective-v1` signed 提案或计划不满足当前结构合同时必须重新生成、签名并刷新。事件时间只能由证据确定性聚合，不能由提案任意改写或通过 `preserveFromBase` 覆盖。维护操作必须在 Core 完全停止后创建覆盖默认 Agent 与全部其他 Agent 业务库、队列库的可恢复备份并完成校验；参数化事务只在由该恢复点创建的完整 staging 副本中替换 `memory_records`，生产侧通过可重入 data 目录 journal 安装已全量验证的数据库集合，不能修改会话、队列、请求日志或其他业务表。重整后必须核对每个 Agent、每类来源的前后数量、样本、完整 row shape、`integrity_check`、queue 不变量和恢复能力。

### 5.2 调度

主对话记忆不设置调度器、待处理消息、批次、压缩阈值、静默尾批、失败重试、债务告警或定时唤醒。入站与会话记录只为当前回复和召回提供上下文；工作记忆与用户画像决定在同一次主回复 Provider 工具循环内同步完成。服务启动只清理旧版本遗留的 `memory_scheduler` 与 `memory_batches` 表，不恢复或消费其中的数据。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆 Markdown、长期记忆 SQLite 和用户画像 SQLite 中搜索。人物检索与召回提示只使用 QQ 和 `addressNames`，`userName` 不参与语义检索或提示身份展示。工作记忆提示内容同时呈现宿主记录时间与会话来源；长期记忆和用户画像继续由 SQLite 持久化并有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

### 5.4 Agent 知识库

每个 Agent 的资料根目录固定为自身 workspace 下的 `workbench/knowledge/` 与 `docker-workbench/knowledge/`，两套资料树各自支持任意层级目录并递归扫描 `.jsonl`、`.md`、`.markdown` 与 `.txt` 普通文件；符号链接、硬链接、特殊文件和未知扩展名不进入索引。JSONL 按每个非空物理行独立分段，Markdown 与文本按空行分隔的自然段分段，并为每段保存从 1 开始的原始行号范围。单文件最多 8 MiB、每套资料树最多 10,000 个文件、目录深度最多 32 层；UTF-8、文件身份或读取边界异常时，该文件以稳定错误状态进入清单且不产生检索分段。`knowledge_search` 同时检索两套独立 FTS5 索引，Docker 结果路径以 `docker-workbench/` 前缀区分，并按统一分数截取最终上限。

资料根目录自身固定生成 `index.json` 管理入口，包含 schemaVersion、当前文档相对路径、格式、字节数、分段数、索引状态、稳定错误码和更新时间；每次同步先完成资料扫描与 FTS 事务，再以 0600 同目录原子替换该入口，入口自身不作为知识正文进入检索。检索索引位于 `workspace/cache/knowledge/<agentId>.sqlite`，使用 FTS5 外部内容表和 BM25 排序，并为中英文正文和相对路径生成确定性检索 token。索引只保存可从资料树重建的文件元数据与分段，不属于业务恢复点；文件大小、mtime 或 ctime 变化时增量重建，管理员可显式全量重建。`knowledge_search` 只绑定当前 Agent，返回相对路径、精确行号和最多 4,000 字符的有界正文。

知识资料引用本地图片时必须使用真实 Markdown 图片链接，并把图片保存在同一 `knowledge/` 树内。Native 结果的文档路径相对 `knowledge/` 根，链接目标先相对来源文档解析，再且仅再添加一次 `knowledge/` 得到 Workbench 根相对路径；资料正文显式声明的 Workbench 根相对路径已经是最终路径，不能再次添加 `knowledge/`。两种路径都必须由 Bash 精确核验存在后才能进入 `generate_img` 或 `selfie.referenceImagePaths`。

### 5.5 场域知识

场域知识是当前角色可编辑的场域—约定记忆，不属于工作记忆、长期记忆、用户画像或 Agent 资料库；管理台将它作为记忆页的平级来源展示和编辑，不再列入 Agent 提示词。它保存在当前 Agent workspace 的 `AIR.md`，固定使用 `# 场域知识`、`## 使用边界` 与 `## 场域约定` 三层结构，只记录明确适用范围内的称呼映射、内部词义、规则、边界、前提、例外和仍有效约定。

明确表达的“不要做某事”“请这样称呼我”“这个词在这里表示某意思”和场域规则属于强证据；未说明范围、只出现一次或仍在猜测的模式不能固化为约定。公共百科、公共热梗、天气、午餐、座位、一次性事件、聊天原话、近期流水与关系情绪变化不进入 `AIR.md`；私聊、用户群聊和 Bot 群聊约定都必须携带范围，不能跨场域传播，也不能把玩笑升级为真实行动。

`read_air` 调用使用独立模型请求把原有场域知识、最新聊天记录和角色注入理解合并成完整替换稿；Dream 也可用本轮允许的真实记忆证据清理旧琐事或生成完整替换稿。生产 Dream 不为身份生成别名、哈希或反向恢复绑定：工作记忆与长期记忆事实、用户画像、实际会话、任务、Director、人格印象和 `AIR.md` 中边界内的姓名、称呼、QQ 与参与者字段均以有界原值直接发送给当前 Agent 配置的 Dream Provider。投影仍使用封闭字段集合并脱敏凭据、秘密、邮箱和宿主绝对路径；只有投影后的 `AIR.md` 与规范化原文逐字一致、没有发生秘密或路径脱敏、字段截断和总载荷收缩时，才把 `fieldKnowledgeWritable` 设为 true 并允许持久化替换稿，其余运行要求模型返回 null。模型输出出现旧式 `人物-<10/24hex>`、`person:<24hex>` 或同类宿主身份代号时按严格输出合同失败并进入既有 Dream 重试。两条路径都不追加增长型历史，不使用 JSON/JSONL 或业务 SQLite；`AIR.md` 与其他人格 Markdown 一样属于小型配置文件。文件写入使用 64 KiB 上限、符号链接拒绝、revision CAS、串行队列和原子替换，成功或回滚后热重载当前人格；模型请求、工具调用和成功或失败结果进入请求日志，但不得把秘密或宿主绝对路径写入日志。`air-field-contract-v2` 只把可精确识别的官方旧模板升级为当前结构，`dream-raw-identity-v1` 只替换官方旧身份别名说明，其他管理员自定义正文保持原样。

图片消息在入站准备阶段由当前 Agent 的独立读图节点生成简短中文 alt text，推荐表达为“一张包含……的图片”或“一张有……的图片，他们正在……”。alt text 与图片媒体分离保存到消息记录，进入后续会话历史、群聊编排与主回复上下文；多模态主模型也必须收到该文本。alt text 只提供快速语义，媒体句柄仍是获取原图和核对细节的唯一会话引用。

### 5.6 每日 Dream

Dream 的工作记忆输入固定读取当前 Agent workspace 的 `WORKING_MEMORY.md`，捕获时把文件 revision、当前长期记忆摘要和安全上下文写入当日 `dream_runs.input_json`。旧 SQLite 工作记忆不迁移、不恢复到 Markdown、不删除，也不参与新 Dream。一次 Dream 从输入捕获、持久运行 claim、payload 与提示词构建开始，到 Provider、工作记忆 CAS、长期记忆 SQLite 添加与运行完成结束，共享 600 秒硬预算；取消后不得继续提交状态、记忆或操作日志。

模型只输出三个按序顶层字段。`workingMemoryCompression` 是最多 4,000 字符的完整压缩正文字符串，直接替换整份工作记忆；输入为空时允许返回空字符串，输出中没有单项、工作记忆 ID、来源映射或 discard 动作。`longTermMemoryAdditions` 是新增长期事实的字符串数组，只能依据整份工作记忆生成；宿主为每条事实生成稳定 ID、事件指纹、`dreamRunId` 与 `consolidatedBy=sunabot.dream`，并在当前长期记忆中按稳定 ID、事件指纹和规范化事实去重。既有长期记忆逐字段保留，Dream 不改写、合并、归档或删除它们。

模型在内部推理中判断候选事实是否值得长期保存，并在零新增时确认存在正当依据；最终 JSON 不输出判断过程、原因文本或决策码。启动迁移会清除旧 Dream 提示词中的单项工作记忆、来源 ID、显式原因与决策字段合同。模型提议因重复或提交时快照变化而实际新增为零时，宿主结果只记录 requested、added、duplicate 与 unavailable 数量。

`dreamDescription` 只持久化到当日 `dream_runs.dream_text` 并进入 Dream 历史，不写入工作记忆、长期记忆、人格或场域知识。既有历史 Dream 工作记忆继续原样保留，后续 Dream 不再新增这类工作记忆。

合同解析发生在 `markGenerated` 之前；格式、字段顺序、字段类型、额外嵌套结构、超限工作记忆正文或空梦境正文无效时以 `DREAM_OUTPUT_CONTRACT_INVALID` 失败，同一运行最多自动尝试 3 次。合法 parsed JSON 直接持久化，恢复 generated 阶段时对现有三字段对象重新执行相同校验，不重复调用模型。提交顺序为整份工作记忆 Markdown revision CAS 后长期记忆 SQLite 事务；SQLite 失败时按新 revision 回滚工作记忆。工作记忆 revision 漂移只跳过该软链接写入，长期记忆 snapshot 冲突仍整体失败，避免覆盖并发长期记忆写入。

管理台可随时为所选 Agent 手动触发 Dream。同一 Agent、系统时区自然日仍只保留一条运行记录；当日记录已完成时，显式手动触发使用当前时间重新捕获最新记忆与安全上下文，在同一行清空上一轮输入输出结果和完成状态、重置三次尝试预算并重新进入 `running`，历史最终展示当天最新梦境。当日失败记录可由管理员明确恢复；有效租约仍在时继续以 `DREAM_BUSY` 拒绝并发执行。自动 04:00 调度保持自然日幂等，不因手动重复触发建立历史欠账。历史显示工作记忆压缩数、长期记忆新增数、梦境正文和尝试状态，不显示原因、内部推理、旧的合并、归档、转存、人格或场域知识结果。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- `.docx`、`.pptx`、`.xlsx`、`.odt`、`.odp` 与 `.ods` 正文由锁定的纯 Node `officeparser` 解析；同一解析器可通过 `npm run office:read -- <path> --to=text` 在 Bash 中直接使用，不依赖 GUI、桌面 Office、Python 或 Java。
- 旧版二进制 `.doc`、`.ppt` 与 `.xls` 不再通过外部 Office 套件转换，统一提示另存为现代格式；演示文稿保留分节正文和 `officeparser` AST 暴露的幻灯片数，不生成视觉页。图片页会计入页数；完全空白且未被解析器暴露为 slide 节点的页面可能少计，不使用可选元数据推测页数。PDF 与图片继续提供视觉上下文。
- 附件 artifact manifest 保持 `version: 1`，Office 解析结果另带 `parserRevision: 2`。缺少当前 revision 的既有 `.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.odp/.ods` `ready` 或 `partial` 缓存必须重解析；PDF、图片和文本缓存不受 Office revision 影响。
- Office 正文解析在独立 Node worker 进程组中执行，默认最多并发 2 个任务、单任务 90 秒、V8 old-space 768 MiB、IPC 1 MiB、工作目录 1 GiB、进程组 RSS 1.5 GiB；任一上限命中后固定保留首个错误并按 TERM→KILL 有界终止整个进程组。工作目录与 RSS 探针各自独立收敛，单个或两个探针失败都不能提前解除另一资源门禁或总超时；探针 callback、进程组信号和 fallback signal 抛错必须被消费并进入有界 stderr，不能产生未处理 Promise rejection。
- 原文件按内容哈希进入附件缓存。
- OneBot 附件查询必须使用接收该消息的 `accountId`。当前消息使用入站账号，引用或历史消息补水使用会话记录所属账号；`get_private_file_url`、`get_group_file_url` 与 `get_file` fallback 在一次解析中保持同一账号，不能因缺省 action 路由到 `primary`。
- OneBot 文件段的显式 `file_id` 与非 URL `file` token 分别进入 `fileId` 和 `fileToken`；显示名称只用于展示和类型判断，不能填充下载定位。token 在入站和 SQLite 投影前都必须拒绝 URL、URI scheme、POSIX/Windows/UNC 绝对路径、反斜杠及 C0/C1 控制字符。
- 附件获取状态与正文解析状态独立。获取成功先写入 schema v1 `AttachmentBlobRefV1`，记录 cache key、SHA-256、大小和检测类型；解析随后进入 `not_started|pending|ready|partial|unsupported|parse_failed`。显式 acquired 的原件即使解析失败仍可通过当前会话句柄导出，旧 `failed`/`unsupported` 记录不能只凭遗留 cache 字段推断 acquired。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

OneBot 入站图片的媒体数组保持原消息中的可用地址顺序，正文使用同序号的 `[内容图片#N：摘要]` 或 `[表情图片#N：摘要]`。内容图片参与事实理解和后续受控媒体句柄解析；表情图片只提供情绪、语气与交流意图线索，除非用户明确要求分析该表情本身。远程图片即使源文件未超过 8 MiB，只要尺寸超过文本模型输入上限，也必须在进入读图或主回复前按预览合同缩放到最长边 2,048、最多 16,000,000 像素并重新编码；不能因字节数尚未越界而把高分辨率原图直接内联到文本 Provider。图像 Provider 从内容寻址原件经独立高保真管线派生参考副本。合并转发聊天记录中的嵌套图片使用同一分类和媒体序号规则，并随展开后的发送者与消息顺序进入会话。

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图校验、重试和 OneBot 外发。`generate_img` 与 `selfie` 的全部生图参数及参考图使用意图由模型填写；当前会话 workbench 中的已有图片可通过相对路径或 Bash 实际返回的授权绝对路径直接传入。管理员私聊的 Native 绝对路径必须位于当前 Agent Native workbench，也可使用同一 Agent Docker workbench 的宿主绝对路径或 Docker Bash 返回的 `/workbench/...`；管理员群聊与普通 QQ 会话只接受 Docker `/workbench/...`，其中 `/workbench/native-workbench/...` 按既有只读投影解析到当前 Agent Native workbench。运行时先把绝对地址归一化为所属 workbench 与安全相对路径，再沿用同一描述符、根身份、文件类型和变化检测；其他宿主绝对路径、URL、媒体句柄、Base64、目录、链接、变化中的文件及非图片在该参数中全部拒绝。知识搜索正文中的 Native Markdown 图片链接必须按来源文档解析为仅含一次 `knowledge/` 前缀的 Workbench 根相对路径，正文明确标注的 Workbench 根相对路径则原样使用；两者都必须先由 Bash 核验精确文件。缺失、越界、无权、链接或不稳定参考图在异步任务创建前返回 `SELFIE_REFERENCE_*` 或 `GENERATE_IMG_REFERENCE_*` 诊断码，不得伪装成 `SEND_FILE_*`。历史消息、当前消息与最多两条明确引用消息中的图片都以 `message:<message-id>:image:<index>` 媒体句柄提供给模型，精确句柄优先于 workbench 路径、显式 URL 和来源回退。来源回退包含 `none`、`current`、`previous_output`、`history`、`current_and_history`；群聊中的自动历史只选择当前用户的媒体，精确句柄只能解析当前会话和当前捕获序列内的媒体。异步图片任务在 dispatch 时把 workbench 参考图归档为内容寻址的不可变 URL，并持久化原始路径到归档 URL 的映射；本次工具实际需要的当前、引用和历史聊天图片也必须在 dispatch 完成下载、类型与摘要校验并以原始字节写入当前 Agent 的内容寻址会话归档，远程下载执行 1 次初始请求和最多 3 次重试。队列中的聊天参考图只保存 schema v1 的 SHA-256 与不可变归档 URL，工具参数和入站快照只能引用归档 URL，不能保存远程 URL、Base64 或附件缓存路径。旧任务没有聊天快照时按原捕获序列重建。模型显式提交的任一媒体句柄无法解析、必需参考图无法下载或归档、归档在 Provider 输入阶段无法形成对应数量的 `input_image` 时，图片任务必须在调用图像 Provider 前明确失败，不能丢弃参考图后继续纯文字生图。`selfie` 成功后由异步完成回调把生成图片直接加入 `assistant_reply` 并交给 OneBot 媒体出站，模型不得再次调用 `send_file` 或猜测生成文件路径；发送前生成文件缺失必须以 `OUTBOUND_MEDIA_SOURCE_MISSING` 失败，不能记录或回复伪造成功。聊天中的 `generate_img` 与 `selfie` 成功结果、管理台 playground 结果都写入当前 Agent 的 SQLite 图片历史。升级到 SQLite-only 图片历史时，运行时首次初始化按 Agent 扫描受控生成 PNG 并一次性回填缺失元数据，跳过 `emoji-*`、符号链接和其他文件；之后列表请求只读取 SQLite。历史生成图与会话图片归档的 `/generated-images/` 路径只允许生成图片根目录下的受控结构；文本模型视觉输入由受控原图生成最长边 2048 的有界 Data URL 副本，图像 Provider 参考输入从同一受控原件生成最长边 3840、最多 8,294,400 像素、最多 16 MiB 的高保真 JPEG 或 PNG Data URL，两个派生管线均不覆盖内容寻址原件。会话图片归档位于 `conversation-assets/agents/<agentId>/<sha256>.<ext>`，不进入生成图片历史。聊天回复中实际发送成功的 `emoji-<sha256>.png` 或 `emoji-<sha256>.gif` 表情把已校验字节对应的不可变会话归档 URL 写入 assistant 会话媒体，在后续上下文中提供精确句柄，并可由 `generate_img` 或 `selfie` 作为参考图；原始表情 workbench URL、宿主路径和 Base64 不进入会话消息。表情仍不进入 SQLite 生成图片历史，纯表情记录不会自动触发工作记忆或用户画像写入。表情媒体在内部有序内容段中标记为 `sticker`，跨 Core/NapCat 继续传输受控图片字节并映射为 OneBot `image` + `sub_type=1`；普通生成图不携带该 subtype。自拍始终使用当前 Agent 的角色参考图与 `selfie_prompt_rewrite.json`；primary Plana 在新建、缺失或空白文件及渲染回退时使用普拉娜专用改写模板，所有其他 Agent 在相同路径使用只依赖当前人格与角色参考图的通用模板。当前 Agent workspace 的 `workbench/selfie/` 与 `docker-workbench/selfie/` 是两套各自最多 9 张的带备注素材库，每张图片必须具有可编辑备注；节点合并两套 `{id,note}` 元数据，按内容 ID 去重并严格选择 1—3 张。每套 `references.jsonl` 每行保存一个 schemaVersion 1 的 `{id,fileName,note}` 记录，与目录一致时只读取所选图片并保持节点返回顺序；零字节或单个结尾换行表示空图库。管理员私聊 `import_chat_selfie` 写 Native，管理员群聊写 Docker；管理 API 可按 Workbench 独立寻址。升级迁移先在旧 `selfie/` 完成 JSONL 转换，再把完整目录移入 Native workbench，并为 Docker Workbench 补齐独立空入口。外部参考图最多额外保留 1 张，并紧接已选择的 1—3 张自拍素材追加为实际最后一项，不填充空槽位；单次生图总参考数仍不超过 4。节点空选、未知、重复或超量 ID 时不得截断、随机回退或继续生图。管理台可在图像页上传、预览、编辑备注和删除素材；列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件与内容寻址会话图片归档保存在忽略的运行目录，图片历史和会话消息元数据保存在主 SQLite 数据库。

其中知识图片路径遵循 5.4 的单一合同：Markdown 图片链接解析为恰好一个 `knowledge/` 前缀，显式 Workbench 根相对路径原样使用；缺少真实链接、未完成 Bash 核验、重复前缀或猜测出的路径都不能派发图片任务。

生图工具的 `size` 是最终落盘像素合同。Provider 返回尺寸或宽高比与请求不一致时，结果写入器必须等比缩放并居中完整适配请求画布，空余区域使用透明留边，不得裁切或拉伸原图，随后保存为精确尺寸 PNG；4K 竖图必须实际为 2160×3840，4K 横图必须实际为 3840×2160，不能只在日志或 `revisedPrompt` 中记录请求尺寸。OneBot 出站只把该受控 PNG 原字节编码为 `base64://`，不得再次缩放、裁切或转码。

生图任务从参考图读取、远程参考图下载与输入派生开始，到建立请求、全部传输重试和读取完整响应正文结束，共享 10 分钟总预算；自拍的提示词改写与后续生图也共享同一预算。Codex 生图的非取消传输异常使用同一可重试分类，按固定退避最多尝试 3 次；调用方取消、`AbortError` 与预算耗尽不重试，底层 fetch 与 OpenAI SDK 请求都必须接收同一取消信号。异步图片任务最终失败时，回调先读取工具结果中的业务错误，再读取持久化任务错误；已知传输中断统一显示为“上游生图连接中断，请稍后重试”，不能降格为“没有可用图片”或暴露内部错误类型。

聊天媒体导出不把消息字节、Base64、临时 URL、协议 token 或宿主路径加入会话 SQLite、提示词变量或增长型 JSONL。当前/引用图片按需进入当前 Agent 内容寻址附件缓存，文件复用入站获取产生的同 Agent acquired blob；通过类型、摘要和文件身份复验后，才把一份 0600 原始字节副本发布到当前会话能力快照选择的 Workbench，管理员私聊写 Native，群聊与普通私聊写 Docker。返回的宽高仅来自已成功解码的图片，普通文件返回 `null`；文件名扩展与检测格式不一致、声明 MIME 与检测 MIME 不一致、损坏图片、空文件、超限或源文件变化均失败关闭。只有 Codex 输入冻结和产物 finalizer 的封闭调用点允许未知但有界的普通文件继续流转，并把无可信 magic 的类型降为 `application/octet-stream` 与 `.bin`。导出副本属于 Bot 明确保存的工作产物，不自动进入知识库、Skill、自拍或表情选择。

聊天表情导入直接复用 `EmojiLibraryRepository` 的规范化 admission 与 `EmojiJsonlStore` 串行原子写，不产生第二份目录索引。相同 key 与相同规范化 SHA 返回去重状态且不增加版本；不同 key 可引用同一内容寻址表情文件，不复制图片字节。工具返回规范化图片的 SHA、尺寸和字节数，原始聊天图片仍只保留在缓存生命周期内。
自拍改写的 Provider strict JSON schema 只使用目标 Provider 支持的关键字，不在数组节点提交 `uniqueItems`。既有 `selfie_prompt_rewrite.json` 通过一次性保留式迁移只移除该关键字，管理员自定义正文与其他 schema 字段保持不变；节点空选、未知、重复或超量 ID 继续由运行时解码器严格拒绝。

出站媒体必须先通过生成图片根目录、直接子文件、PNG 文件名、常规文件和大小校验，再读取为 OneBot `base64://` 内联数据。Native Core 与 Docker Core 使用同一传输方式，NapCat 不读取 Core workspace，不接受共享绝对路径。超过 OneBot 内联预算的文件必须使用独立、鉴权、限流、可过期的传输协议；不能用容器路径或宿主路径作为降级。

每个 Agent 的表情图库最多保留 64 个 key，内置的 11 个预设 key 只作为管理台生成入口，不代表图片已经存在。key 必须先在原始 Unicode 上拒绝 C0/C1 控制字符、方括号、斜杠、反斜杠、replacement character 和孤立代理项，再执行 trim 与 NFC；结果要求 1—24 个 Unicode code point、最多 64 UTF-8 字节。上传只接受最大 8 MiB 的 PNG、JPEG、WebP 或 GIF；一键生成在调用 Provider 前必须取得当前 Agent 至少 1 张有效自拍参考图，最多使用 3 张，零张或不可读时返回可重试结果并保持 Provider、图片与目录清单零写。PNG、JPEG、WebP 与生图结果统一旋转、裁切并规范化为 1024×1024 内容寻址 PNG，文件名固定为 `emoji-<sha256>.png`；GIF 对全部帧执行相同的旋转和居中裁切，保留帧顺序、时长与循环信息，规范化为每帧 1024×1024 的内容寻址 GIF，文件名固定为 `emoji-<sha256>.gif`。规范化文件最多 16 MiB。

表情目录以同目录 `emojis.jsonl` 作为唯一当前元数据源，一行对应一个 key，保存 schemaVersion、key 创建/更新时间、当前内容寻址文件名和最多 20 个版本的文件名、来源、字节数、尺寸与创建时间；每个 Agent 在 `workbench/emoji/` 与 `docker-workbench/emoji/` 各有独立清单与引用 PNG/GIF。清单最多 2 MiB，读取使用 UTF-8 fatal decoder、严格字段、key/版本唯一性、当前版本存在性、普通单链接文件与稳定身份校验；写入使用同目录 0600 临时文件、fsync、原子替换和目录 fsync。合法的外部原子替换通过文件身份变化触发重读，损坏清单失败关闭。运行时合并两套可用记录，同 key 以 Native 为准；API 内容 URL 使用 `workbench` 或 `docker-workbench` 路径段保持来源不变。

既有 SQLite `emojis` 与 `emoji_versions` 只作为一次性迁移来源：当前 Agent 首次访问表情目录且清单缺失时完整读取当前项与版本，先持久化并复读 JSONL，再清空旧 SQLite 表情行；清单已经存在时以 JSONL 为准并清理残留旧行。中断发生在 JSONL 发布前时继续使用旧行重试，发生在发布后、清理前时下次访问复用已发布清单再清理，不得把旧行覆盖回 JSONL。

提示词 key 列表只执行 JSONL 字段、内容寻址文件名、普通非符号链接文件与记录字节数的廉价候选检查，不同步读取或哈希最多 64 张图片；未被本轮选中的损坏文件不能阻断回复。API 列表、内容读取和本轮实际命中的唯一资产使用最多并发 2、最多等待 2 的异步完整性门禁，以 `O_NOFOLLOW` 打开同一文件句柄，复验完整父目录身份、fstat、大小、PNG/GIF 结构、每帧 1024×1024 解码、流式 SHA-256 与读后身份；dev、ino、size、mtime、ctime 未变时复用有界缓存，指纹变化必须重验。无效记录在列表中隐藏，命中无效资产时在 durable outbox 前失败关闭；延迟 OneBot 投递再次核对内容寻址摘要。

生成门禁按 Agent 最多并行 2 个 key，同 key 在途返回 409，容量耗尽返回 429；上传与生成的规范化门禁按 Agent 最多并行 2 个且不排队，admission 必须早于上传 Base64 解析或生成文件读取，容量耗尽返回 429。409/429 均提供明确状态，429 携带 `Retry-After`，所有 slot 在成功或异常的 finally 中释放。目录创建与最终内容寻址文件发布使用 parent-bound 操作；父目录、最终目标或 worker 绑定后发生替换时，外部路径和表情 JSONL 都保持零写。

NapCat 上报的 QQ 文件优先通过 OneBot action 返回的受控 URL 进入 Core；统一启动器固定开启 `get_file` Base64 回退。仅返回 NapCat 容器内路径时不能由 Core 直接打开，也不能为兼容该路径而挂载业务 workspace；超过现有 action 预算的文件使用后续明确的流式协议。

### 6.3 Agent workbench 文本文件

每个 Agent 的 `workbench/` 是 `read_file`、`write_file` 与 Bash 共用的私有文件边界。文件工具只处理 well-formed UTF-16、NFC 规范化的 POSIX 相对路径，路径最长 1024 UTF-8 字节，单段最长 255 字节；绝对路径、反斜杠、空段、`.`、`..`、lone surrogate、NFD、C0/C1 控制字符、符号链接、非普通文件、多个硬链接和跨 Agent 路径全部拒绝。大小写与 Unicode replacement character 不折叠或替换。读取上限为 1 MiB，并另以 262,144 个 JavaScript 字符限制模型输出；UTF-8 使用 fatal decoder，文件开头的三字节 BOM 保留为正文首字符 `U+FEFF` 并计入 `byteLength`，无 BOM 正文不变。读取使用 `O_NOFOLLOW` 的同一描述符，在读前、读后及路径复验之间核对根目录、父链、设备、inode、ctime、mtime、大小和链接数，文件在检查后增长时最多读取上限加一个字节后拒绝。

自拍、表情、Skills 与知识库同时位于 Native `workbench/` 和独立 `docker-workbench/`，两套目录分别使用 `selfie/references.jsonl`、`emoji/emojis.jsonl`、`skills/index.json` 与 `knowledge/index.json`。运行时合并自拍、表情和知识库入口；管理 API 的读取使用 `workbench=all` 聚合两套资源并为每项保留来源，`workbench=native|docker` 继续读取或修改指定仓库。管理台新增自拍、表情和知识资料固定写入 Native 标准位置，修改、删除、表情版本与内容读取按条目原始 Workbench 路由，不复制或迁移现有内容；Docker Skills 可作为独立源包工作区，激活仍要求经仓库审查发布到 Native Skill 索引。需要长期记住的聊天图片先由 `export_chat_media` 导出到当前会话对应的 workbench，再由获准的 Bash 放入该 workbench 的 `knowledge/` 并创建可索引的相邻 Markdown 资料；资料使用相对自身位置的 Markdown 图片链接指向原图，`add_workmemory` 正文使用目标以 `knowledge/...` 开头的 Markdown 相对链接，不能只留下裸路径。Docker Bash 的独立 cwd 为 `docker-workbench/`，运行时把完整 Native workbench 只读映射到 `/workbench/native-workbench/`；两个工作区不共享可写目录。Native Bash 通过宿主绝对路径与 `SUNABOT_DOCKER_WORKBENCH` 同时寻址两个工作区，Docker Bash 通过 `SUNABOT_NATIVE_WORKBENCH` 只读寻址 Native 投影。

每个 Agent 预装并启用指令型 `workbench-config` Skill，用于表情、Skills、自拍、知识库、聊天媒体和双 Workbench 内容寻址。发行包以 `codex-skills/workbench-config/` 为唯一来源；启动和新增 Agent 时通过现有 Skill 包摘要、确定性安全审查、双摘要批准、事务日志与原子索引发布链路安装或升级，并以 `source.kind=bundled` 标记来源。相同 ID 的非预装 Skill 属于显式冲突，启动不得覆盖。Skill 明确以本轮获准 Bash 作为 Workbench 文件检索、创建、转换、整理和维护的首选路径：Native Bash 可在同一 Agent 的 `workbench/` 与 `SUNABOT_DOCKER_WORKBENCH` 内按各自固定入口、现有 schema、写前摘要或 revision、同目录原子替换和发布后回读更新资源；Docker Bash 可写独立 `/workbench` 并从只读 `native-workbench/` 取用 Native 资源。当前 Agent 配置的管理员 QQ 在私聊和群聊中可于本轮实际提供 `import_chat_emoji` 或 `import_chat_selfie` 时分别导入表情和自拍参考，私聊写 Native，群聊写 Docker。聊天媒体句柄仍先由 `export_chat_media` 取得受控字节，Skill 安装、替换、独立审查、启用与删除仍由 Skill 仓库执行摘要绑定和 CAS，Bash 负责源包创作、维护、验证、哈希与归档且不能伪造批准字段。该 Skill 只能说明并调用当前会话已经暴露的工具，不能扩大 Bash、文件、聊天媒体或资源仓库权限。

`write_file` 不创建父目录，只能在已经存在且身份稳定的安全目录中发布完整文本。正文先拒绝 lone surrogate 并执行字符与 UTF-8 字节预算校验，不改变正文的 Unicode normalization form；随后写入同目录随机 0600 临时文件，循环写完并 fsync，再从同一描述符冻结设备、inode、ctime、mtime、大小、权限、链接数、SHA-256 与实际正文。`afterTempSynced` 和 `beforePublish` 检查点都位于最终复验之前；发布前重新以 `O_RDONLY | O_NOFOLLOW` 打开临时文件，用同一描述符有界读取并核对路径身份、完整冻结快照、摘要和正文。无覆盖创建通过硬链接发布保证目标不存在，覆盖通过同文件系统 rename 原子替换，随后再次 fsync 目录，并从目标描述符复验安全身份、摘要和正文。失败时清理自身临时路径，错误响应和请求日志只保留稳定错误码、相对路径及大小，不包含正文、宿主绝对路径或文件系统错误元数据。

五种 Provider 协议写入模型请求日志前，必须对日志副本执行 action-aware copy-on-write 投影，实际 SDK request 对象与 fetch JSON 字节保持不变。Responses、Codex Responses、Chat Completions、Anthropic Messages 与 Gemini generateContent 的 `read_file`/`write_file` call 参数只记录 canonical 相对路径或 `[invalid]`；写入参数另记录 `overwrite`、UTF-8 `contentByteLength` 与固定 `[REDACTED]`，不记录正文、额外字段、宿主路径或无密钥摘要。`read_file` result 只保留安全的 `ok`、路径、字节数和固定正文占位，无法解析的结果整块替换为固定占位；`write_file` result 不记录正文。投影只识别各协议真实 call/result lineage，普通 user 与 assistant 文本即使形似工具 JSON 也保持原文。日志入口必须先在不读取 accessor 的前提下生成 inert plain-data 副本；任一 getter、Proxy、`toJSON`、循环引用、BigInt、自定义原型或序列化异常都把整份 request 日志替换为固定无敏感信息摘要，禁止回退原始 request，也不能阻断后续 SDK 或 fetch 请求。

### 6.4 会话文件、图片与语音外发

`send_file` 向允许回复的当前 QQ 单聊或群聊发送本轮授权 workbench 中的文件，不接收 QQ 号、群号或账号参数。管理员私聊绑定 Native workbench；管理员群聊、普通私聊和普通群成员绑定 Docker workbench，使群聊下的 Docker Bash 产物可直接形成回传闭环。伪造调用、显式 `web` transport、sender 已关闭、缺少 OneBot 文件能力或 durable outbox callback 时不能获得 Provider port，运行时 queue 必须在文件解析前再次拒绝并保持零 outbox。真实 OneBot parser 保留既有 `transport` 缺省值，持久目标始终规范化为 `onebot`。调用保留当前 `account_id`，缺省账号必须冻结并传递为显式 `primary`，禁止 OneBot 回退到唯一 secondary socket；群聊不能转成私聊，单聊不能改投其他用户。durable path 统一使用 POSIX `/`，queue 与 decoder 均拒绝反斜杠、绝对路径、空段、`.`、`..`。发送前必须拒绝符号链接、多个硬链接、非常规文件、非法文件名和超过 32 MiB 内联预算的内容。helper 返回后立即冻结选定 workbench 的 canonical path、dev、ino 与高精度 ctime；outbox 只持久化不含路径的十进制 dev/ino/ctime 身份并纳入 fingerprint。delivery 先按持久根身份在 Native 与 Docker workbench 中匹配原根，以兼容已经排队的旧 Native 资产；构造、路径解析、descriptor open 和读取前后都必须确认根仍是同一常规目录，不能用后续 `realpath` 结果重新确定可信根。同机 SQLite 重启可继续投递，跨文件系统迁移、root inode 或 ctime 变化均安全拒绝并要求重新排队。写入 outbox 前还必须重新确认 helper 结果相对冻结根仍是安全相对路径。路径链预检后必须以 `O_RDONLY | O_NOFOLLOW` 打开文件描述符，以初始 `fstat.size` 分配有界 Buffer，循环读取不超过该大小并额外探测一字节；读取前后用 `fstat` 和当前路径的 dev、ino、大小复验，整个读取使用同一 FileHandle。根目录、叶子或中间目录发生替换，即使随后换回，或读取期间文件增长，都一律拒绝且不得生成 Base64。任何可识别且 `code` 匹配 `E*` 的 filesystem error，无论是否带 `path`、`dest`、`syscall` 或 `errno`，都必须转换为稳定的 `SEND_FILE_SOURCE_*` 或 `SEND_FILE_ROOT_CHANGED` 错误；仅在 message 中泄露绝对路径的错误，以及 FileHandle 的 open、read、close 错误，也执行相同归一化。工具输出、请求日志和 outbox 错误不能包含 Agent workspace、workbench 或宿主绝对路径。outbox 投递还要复验文件内容摘要，避免排队期间文件被替换。图片资产在远端发送前按已复验的实际字节写入当前 Agent 内容寻址归档；远端成功回执在 settle 阶段原子写入 assistant 会话消息、受控图片 URL 和工具来源，重试通过 settle key 与消息 ID 幂等，非图片文件与语音不创建图片消息。

`conversation_asset` 是无历史兼容负担的新 durable kind，只接受 `schemaVersion: 2` 的 `runtime.conversation_asset` envelope，未版本化裸 payload 一律拒绝。envelope、payload、target、asset、root identity 与 `replyGate` 全部使用 exact-key decoder，未知、缺失或非法字段在 workbench 读取前安全拒绝。`replyGate` 必须存在，`generation` 为有界非空值，`scope` 与 `conversationId` 必须匹配冻结入站目标，两个 epoch 必须是非负安全整数；缺失或非法时禁止捕获当前 gate 作为回退。payload 只保留严格目标、不可变 origin identity 的 SHA-256 fingerprint、文件元数据、根身份、tool/log 标识和 gate，不复制正文、sender、quote、inline data、shared file、附件路径、视觉路径或其他入站快照。origin fingerprint 只规范化 OneBot transport、目标、messageId、selfId 与 time，允许入站事件落盘后 preparation 补充 sender、引用、媒体和附件而不改变授权身份。投递在任何 workbench 读取前重新读取 canonical outbox，并要求 `sessionId`、`originTurnId`、`kind`、`deliveryPartition`、完整 payload 和 envelope 字段均和当前记录一致；origin turn/event 必须属于同一 session，来源只允许 `incoming_reply` 或 `tool_completion`，并从该权威事件重算 fingerprint、sender 允许状态、目标和 gate。

冻结目标绑定显式 `onebot` transport、当前 Agent、显式账号、scope、user/group、message、self 与 conversation。envelope 的 `conversationId` 必须同时等于 session 和冻结目标，`correlationId` 必须等于 `logRunId`，顶层 `idempotencyKey` 和 payload `incomingFingerprint` 都只使用版本化 canonical identity 的 SHA-256，不嵌入原始正文或 URL。普通 outbox dedupe key 使用 `turn-outbox:<originEventId>:<ordinal>:<fingerprint>`，fingerprint 覆盖完整 payload、目标、根身份以及 `path`、`kind`、`name`、`byteLength`、`sha256`。operator 明确 `confirmedNotSent` 后允许重放 `delivery_unknown` 资产，重放行固定使用 `outbox-replay:<previousId>:<fingerprint>`；同一层重复调用在 replay 为 pending、sending 或 sent 时都返回同一行，不能产生第二副本。若 replay 自身再次进入 `delivery_unknown`，delivery 必须逐层加载上一 canonical row，每层都要求上一行仍为 `delivery_unknown`、没有 uncertain settle step，并交叉验证 session、origin turn、kind、partition、完整 payload 与可复算 replay fingerprint。lineage 记录 visited ID、最多回溯 8 层，最终必须唯一落到 `turn-outbox` root，再使用 root 的 event、ordinal、fingerprint 与 origin turn/event 完成全部 provenance 校验。循环、过深、伪造 key、任一中间行状态或内容变化均保持零文件读取、零远端 action。远端已经成功进入 settle 阶段后仍执行 canonical provenance 校验，但不重新执行会随配置变化的管理员、sender 和 gate send-phase 门禁，使本地 settle 可在管理员配置变化后完成且远端保持 exactly once。

自动模式根据真实文件类型把图片作为 OneBot `image` 消息段发送，其余内容作为文件发送；显式图片模式必须识别为图片。群文件与私聊文件分别使用 `upload_group_file` 和 `upload_private_file`，图片使用当前会话对应的消息 action。Core 只向 NapCat 发送 `base64://` 内联数据，不传递 Agent workspace、Core 容器或宿主绝对路径。OneBot adapter 必须再次强制执行 32 MiB 原始字节上限，先由 metadata `byteLength` 得到唯一编码长度与 padding，再线性校验字符和末尾 padding bits；校验过程不得通过 `Buffer.from(encoded, "base64")` 分配第二份大体积 decode Buffer。

`send_voice_message` 使用当前 Agent 的 Voice Profile 与在线 OpenAI Audio 兼容端点，把模型 Function Call 中的同源可读正文合成为 WAV，再作为独立 OneBot `record` 消息段发送。Profile 固定保存协议、Base URL、API Key 环境变量名、模型，以及 `zh`、`en`、`ja` 三个语言槽位的音色 ID；启用时默认语言必须已有音色 ID。运行时语言与音色只取 Profile，不受主会话语言限制，模型不能提交或改写这些值。每个语言仍可保存一份不超过 8 MiB 的参考音频与对应台词作为可选音色资料，但当前在线合成请求不读取或上传该文件。

在线客户端提交最多 300 字的正文、模型和音色，固定请求 WAV，响应最多读取 32 MiB；重定向、超时、非成功 HTTP、空响应、超限或非 WAV 内容均不得写入 outbox。合法结果按 SHA-256 写入当前 Agent `workbench/.voice-cache/voice-<sha256>.wav`，随后复用 `conversation_asset` schema v2、当前冻结目标、origin fingerprint、reply gate、文件身份与内容摘要门禁；OneBot adapter 只接收复验后的 `base64://` 字节并映射为 `record`，不接收在线凭据、Core 路径或供应商响应正文。

同源文字和语音各自拥有独立的准备与 durable outbox 记录。普通正文或 `assistant_text` 与合成并行启动，完成准备的一项立即自然入队；任一失败不撤销另一项。deferred tool 的 acknowledgement 与任务先原子持久化，语音生成完成后通过绑定该 turn 的 deferred emitter 追加；如果合成更早完成，只等待 handoff 已提交后追加。durable outbox 只保证各记录自身的幂等、重试和恢复，文字与语音没有人为先后屏障，远端观察顺序取决于各自完成和队列状态。

### 6.5 日常导演自拍

日常导演不建立独立图像通道。share callback 进入当前目标会话的正常 Agent loop 后调用既有 `selfie`，继续使用当前 Agent 的人格、自拍参考图库、聊天参考图预算、`selfie_prompt_rewrite.json`、内容寻址文件、图片历史与 OneBot Base64 外发。该 callback 单独使用原子图片回复模式：生图在当前 turn 内完成，图片成功前不提供或发送 `dispatch_message`、`assistant_text`、进度、占位、预告、等待提示、会话资产或语音；成功后的简短正文、自拍与其他内容必须进入同一条 durable reply，不能先发文字或拆成多条。普通图片请求仍使用异步图片任务。导演只提供当天已提交活动中的人物、现场、动作、表情、服装与光线意图，不能提供宿主路径、远端目标、参考图 URL 或跨 Agent 媒体。

每次主动分享必须包含当前角色本人并保持已配置外观锚点；同行角色只有在对应活动明确安排时才能出现，老师和现实用户不能被凭空加入画面。自拍未生成时 callback 以 `no_reply` 结束并保留内部失败日志，不能改用无自拍文本伪装完整分享；外发失败继续沿用 durable outbox 的错误与恢复语义，不能重复生成已经持久化的结果。
