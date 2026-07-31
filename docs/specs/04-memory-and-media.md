# 记忆、文件与图片

[返回当前系统规范索引](./index.md)

## 5. 记忆系统

### 5.1 数据边界

| 来源     | 内容                                                   | 主键和更新方式                                        |
| -------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件           | 每 Agent 一份 `WORKING_MEMORY.md`；稳定 ID；revision CAS 与原子替换 |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件                 | event key 与 fingerprint 合并；保留来源工作记忆 ID    |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和称呼数组 | QQ 号聚合；从消息记录提取多个真实称呼，管理员配置进入管理员称呼集合 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆保存在当前 Agent workspace 的 `WORKING_MEMORY.md`，长期记忆和用户画像继续保存在当前 Agent 的 SQLite。当前实时压缩只更新工作记忆与用户画像，不把工作记忆自动晋升为长期记忆；工作记忆文件和用户画像事务分别执行 revision 门禁与原子提交，批次 ID 继续用于用户画像幂等重放。

记忆 Provider 的正文提示统一采用当前 Agent 的第一视角，并显式参考 `SOUL.md`、`PREFERENCE.md`、`USER.md` 与 `RELATION.md`。工作记忆提示词把每条 `fact` 约定为当前角色对一件事的自然语言主观叙述：在输入有依据时把时间、地点或会话场域、人物、事件经过、变化或结果，以及角色当时或现在的感受与判断融进同一段，不机械补齐缺失要素。工作记忆、长期记忆、用户画像和 Dream canonical 的第一人称、句首、回忆提示语及用户自述改写都只作为提示词写作偏好，不使用固定句首或关键词正则做宿主拒绝条件。主观内容仍必须有聊天事实、既有关系或角色人格依据，不能虚构强烈情绪。

记忆正文只保留模型认为仍会影响后续回复的概括信息，工作记忆条数由模型根据当前上下文决定，宿主不按固定数量进行语义裁剪；长期记忆整理结果通常为 3—8 条；每位用户仍只保留一条画像记录，正文通常只含 1—3 个最影响未来相处的稳定认知。工作记忆整理把原记忆与新消息放到同一时间线，同时参考 `fact` 内部时间、`occurredAt`、`occurredEndAt` 和消息顺序；对输入能够证明属于同一事件连续变化的片段，可串联前因、经过、转折、结果与感受变化，形成一条新的综合工作记忆。主题、时间、地点或参与者相近不能单独证明片段相关，提示词不得补造情节、因果、人物、地点或感受。事件合并以 `occurredAt` 保留最早起点、以 `occurredEndAt` 保留最新结果或结束时间，画像的 `time` 保留依据从早到晚的关系。已经结束且不再影响未来的小事应删除。

提示词要求工作记忆 `fact` 使用自然叙述，避免列表、五要素表格、字段标签、分类标题、来源说明、压缩说明或 `事实：`、`时间：`、`地点：`、`人物：`、`事件：`、`情绪：`、`认知：`、`相关用户：` 等模板化前缀，并建议用自然称呼帮助模型理解人物。JSON envelope 与元数据继续服务于宿主持久化，不能反向决定正文写法。宿主不检查正文中的第一人称、称呼、QQ、邻接关系、固定词汇、情绪或表达格式，也不据此拒绝或改写记忆。用户画像以宿主绑定的 `userId` 保存 QQ，以模型返回或当前消息提供的 `userName` 保存显示名，以 `addressNames` 保存去重后的称呼数组。旧 `addressName`、`address_name` 与 `salutation` 在读取或画像合并时归一化为 `addressNames`，新记录只持久化数组。严格 JSON envelope、稳定 ID、来源边界、时间字段、事件键、来源工作记忆 ID 和事务语义保持不变。

用户画像 Provider 的提示词要求逐条参考本批 `messages` 和 `previousProfiles.addressNames`，输出当前用户的聚合画像。宿主只把画像绑定到当前会话参与者：私聊可在模型遗漏或误写可选 QQ 元数据时回落到唯一当前用户，群聊必须能从结构化 `userId` 唯一确定当前参与者。称呼、显示名和正文按模型返回保存，不检查其是否在消息中出现，也不检查正文中的称呼—QQ 配对。工作记忆的可选 QQ 或因果键元数据无效时忽略该可选字段，正文仍进入完整集合。同一合法 JSON envelope 中的空正文条目或无法安全绑定当前参与者的画像条目只跳过该条并记录操作历史，其余画像和工作记忆继续提交；合法空工作记忆集合直接替换为零条，兼容字段 `allPreviousMemoriesInvalidated` 不参与宿主写入裁决。只有顶层 JSON/数组结构无法解析或持久化事务冲突时保留该来源旧值。`memory.compress-out` 保留为可编辑提示词目录和旧模板迁移兼容入口，不额外触发实时 Provider 调用。

`WORKING_MEMORY.md` 的普通记忆可见正文只保存模型返回的自然语言原文，不由宿主插入标题、事项 ID、记录时间、会话来源、来源类型或其他字段。Dream 记忆是唯一可见标记例外：只有 `memoryKind=dream` 的条目在 Dream 原文前显示 `【梦境｜做梦时间：YYYY-MM-DD HH:mm】`，`sourceKind=dream` 和 `dreamReviewedAt` 都不能单独触发该标记；时间取本次 Dream 实际生成整理时间，旧记录缺少该时间时回落到梦境事件时间或宿主记录时间。该标记只用于工作记忆文档展示，解析后的 Dream 原文不包含标记。宿主记录时间、IANA 时区、完整会话来源 ID、scope、可用的会话标题和来源类型保存在同一文件的隐藏 metadata 与 SQLite 操作日志中；记录时间由宿主以系统 IANA 时区生成并包含当时 UTC offset。正文表达的事件时间可以保留为 `occurredAt`/`occurredEndAt`，不能替代记录时间。模型返回和 `add_workmemory` 参数都不能指定持久化记录时间、时区、Agent 或会话来源。直接编辑 Markdown 正文会保留原事项的宿主元数据，损坏的机器 metadata 使整份文档拒绝读取。

工作记忆文档最多 64 KiB，只接受普通文件并拒绝 workspace 或目标符号链接。读取使用 no-follow 文件句柄；写入使用同目录 0600 临时文件、revision CAS、内容完整回读校验与原子 rename。普通实时整理只把 `memoryKind` 不是 `dream` 的记录交给工作记忆模型；提交完整集合时按原事实位置锚点把 Dream 条目逐字段原样合回，模型返回的 Dream ID 不参与写入，因此普通整理不能改写、删除、清空或重分类 Dream。模型整批结果在 Provider 成功并解析出规定结构后按原文写入，宿主只补充不可见的当前 Agent、会话、记录时间与来源 metadata，不增加可见结构，不对正文进行分类、标题化、改写或语义裁剪；正文中的身份、称呼、QQ、因果、第一人称、词汇、情绪、置信度和来源覆盖率均不参与写入裁决。模型以原 ID 和逐字相同正文保留旧工作记忆时，宿主沿用旧记录的身份、事件时间、会话 provenance 与 `sourceDecisionKey`；模型修改旧正文时仍沿用该稳定 ID 的原始会话 provenance 与决策键，避免处理一个会话的批次把其他会话来源重绑到当前会话。新画像的 `createdAt` 始终使用宿主 ISO 时间，模型返回的事实时间或区间只保留在 `time`。数组中的空正文条目单独忽略，合法空数组只清空普通工作记忆；顶层解析失败、文档超限、宿主元数据损坏、revision 冲突或文件安全失败时保留旧文档。普通主回复必须由同一个主回复模型先完成一次 `add_workmemory` 决策：`action=record` 时 `content` 是 1—4,000 字符的正文，`action=skip` 时 `content` 固定为 `null`；两个字段在 strict Provider schema 中都必填。宿主在工具执行开始时原子占用本轮 `pending` 状态，只允许一个并发调用进入写入或跳过，非法参数与写入失败释放占用供模型纠正；只有 `record` 成功写入或合法 `skip` 才完成决策，companion、deferred、`no_reply` 和可见正文都不能越过未完成决定。`record` 沿用相同大小、文件类型、revision 与原子替换条件，不执行正文语义检查或自动改写。生产 Session 把 durable `incoming_reply` event ID 保存为隐藏 `sourceDecisionKey`；进程在 Markdown rename 后、Session turn 完成前退出时，恢复执行通过该键返回原事项，不能重复追加，后续普通整理继续保留该键。

管理 API 读取单个工作记忆来源时，同时返回当前 Agent 的完整 `WORKING_MEMORY.md`、文件名和 revision；不返回宿主绝对路径。管理台以一份 Markdown 文档显示按原顺序连接的记忆正文，Dream 条目保留可见的梦境与做梦时间标记，其他条目不增加宿主标题或字段；所有事项仍不拆成管理台列表，也不显示隐藏 metadata。文档版本与事项 metadata HTML 注释只在阅读视图隐藏，API 原文和磁盘文件保持逐字一致。工作记忆页不提供逐条排序、筛选、召回、分页、新增、编辑或删除入口；长期记忆、用户画像与 Dream 的列表和操作保持各自合同。

工作记忆、长期记忆、用户画像、召回与 Dream 的操作历史统一写入当前 Agent 业务库的 `request_logs`，固定使用 `category=memory.operation`。事件只保存宿主时间、Agent、来源、操作、执行者、结果、稳定原因码、可用的 batch/conversation/record 标识、前后数量与 revision，不保存记忆正文、模型原始输出、秘密或宿主绝对路径。工作记忆追加与替换、`add_workmemory` 的 `record`、`skip` 与未完成决定、自动压缩每次真实尝试的成功或失败、SQLite CRUD、自动批次逐原因验证与提交、召回查询、pending exposure、receipt 和 Dream 阶段都必须产生对应事件；Agent 路由与业务库保持一一对应。成功业务写入之后审计追加失败不能回滚已提交的记忆，必须输出稳定的审计失败日志。该类别只记录上线后的新操作，不回填历史。

`GET /api/memory/operations?agentId=<id>&page=<n>&pageSize=<1..100>` 只从所选 Agent 业务库读取 `category=memory.operation`，按宿主时间从新到旧分页返回，不混入其他请求日志。管理台记忆页始终提供“操作日志”入口，以侧边时间线显示记忆类型、操作、执行者、结果、时间、会话来源、数量变化与原因码；batch、record 和 revision 放在可展开的技术信息中。切换 Agent 时关闭侧栏、清空旧结果并取消旧请求，迟到响应不能覆盖当前 Agent。

工作记忆与长期记忆的 strict 输出都包含 nullable `causalChainKey`。提示词建议只在明确共享原因、转折与结果时复用 `causal:` 键，无法确认时返回 `null`。运行时同时接受 camelCase 与 snake_case 输入；空串、数组、越界或格式非法值作为无效可选元数据忽略，不影响同条非空正文写入。`memory-perspective-v7` 一次性迁移会把已知 v6 工作记忆提示词升级为自然第一人称事件叙事与内部时间线联想合同，并继续识别更早的工作记忆、长期记忆和用户画像官方模板；识别只使用迁移版本、结构化模板 ID、官方当前模板完整指纹及已知旧版本精确内容，不扫描第一人称、感受、看法、称呼、QQ、时间、地点或其他自然语言关键词。迁移保留管理员段落、其他消息、工具与 schema description；完全自定义或无法可靠识别的兼容模板保持原样、记录稳定原因并继续启动。

既有记忆重整时，提案提示词可以约束视角、句首、回忆提示语、直接引语、字段标签、称呼和 QQ 写法，安装器不扫描或裁决这些正文内容。signed 提案仍需绑定当前 Agent、来源行、稳定目标 ID、结构化用户 ID、数量、时间与不可变来源元数据。旧 `memory-perspective-v1` signed 提案或计划不满足当前结构合同时必须重新生成、签名并刷新。事件时间只能由证据确定性聚合，不能由提案任意改写或通过 `preserveFromBase` 覆盖。维护操作必须在 Core 完全停止后创建覆盖默认 Agent 与全部其他 Agent 业务库、队列库的可恢复备份并完成校验；参数化事务只在由该恢复点创建的完整 staging 副本中替换 `memory_records`，生产侧通过可重入 data 目录 journal 安装已全量验证的数据库集合，不能修改会话、队列、请求日志或其他业务表。重整后必须核对每个 Agent、每类来源的前后数量、样本、完整 row shape、`integrity_check`、queue 不变量和恢复能力。

### 5.2 调度

记忆调度器按会话保存待处理消息、当前批次、失败次数、下次重试时间、自上次新批次后新增的消息数，以及失败批次已经用来提前唤醒的新增消息水位。消息窗口由 `bot.memory.messageThreshold` 控制，默认值为 16，可通过管理台“记忆处理”的“压缩阈值”热更新；阈值变化后运行时必须立即按新值重新检查已排队消息。新批次仍需累计一个完整窗口，不因静默时间处理不足窗口的尾部。失败批次固定保留队首原消息和 batch ID，按 1 分钟起步、最高 30 分钟的指数退避自动重试；重试同一批次不消耗后来消息形成新批次的窗口资格，后来消息每新增一个完整窗口可以提前唤醒队首一次，提前重试失败后同一窗口不能形成即时重试循环，也不能越过失败批次。服务重启恢复同一批次、失败次数、重试时刻与提前唤醒水位，已提交游标之前的消息不能重复入队。

`user_group` 与 `bot_group` 只把实际发送并成功落入会话记录的 Bot `assistant` 消息作为记忆锚点。调度器在按序排列的可见、可记忆消息流中，选取每个锚点自身、锚点之前至多 20 条和之后至多 20 条消息的并集；第 21 条不进入候选，重叠窗口按稳定消息标识去重。锚点后的消息在到达时逐条补入 20 条范围，没有锚点或位于全部锚点窗口外的群聊消息不进入待处理队列，也不增加新批次窗口资格。`private` 仍处理全部可记忆消息；`bot.memory.messageThreshold` 的完整窗口规则作用于筛选后的群聊候选。单个会话内所有已入选消息严格按稳定序号 FIFO 处理，跨会话按各队首时间选择最早的可运行批次。

升级后的旧群聊调度状态只有在调用方显式声明输入为完整 retained history 时，才能在允许 claim 前按相同锚点规则原子重建并写入新选择策略；增量历史或缺少该声明时必须保持 legacy 未调和并禁止 claim。旧 `currentBatch` 内仍符合新规则的消息继续视为已经消费过尝试额度；未提交的 failed/running 批次清除旧 batch 与失败状态后，只有不属于旧 batch 的新候选才能增加重试额度，重启不能返还已消费额度。已提交批次只完成游标结算，不能再次调用记忆 Provider，已提交的历史记忆不回溯删除。调度器只额外保留最多 41 条有界群聊选择上下文，用于跨重启补齐未来 Bot 锚点之前和之后的消息，不把该上下文本身计入候选或触发额度。畸形选择上下文必须撤销当前策略并失败关闭，直至重新以完整历史调和；合法但超限、无序或重复的上下文在加载时确定性归一化为最近 41 条。

一个记忆批次从用户画像到工作记忆合并，以及工作记忆快照冲突后的重读与重算，共享 10 分钟外层总预算；每次 Provider 传输上限同为 10 分钟且关闭自动传输重试，只有快照冲突可以在剩余预算内重新请求。批次在旧 120 秒边界后仍保持有效，到达 10 分钟才取消并清理；传输失败、取消或解析失败不能启动第二次传输。超时或失败继续沿用上述队首批次保留与退避重试规则，不能跳过队首、重复提交批次或消耗后来消息的窗口资格。

当前 Agent 的全部会话合计待处理消息连续超过 100 条时，调度器持久建立一个债务告警 episode，并通过同一 Agent 的启用 QQ 账号向已配置管理员私聊排入一次固定通知；已连接的启用账号优先，没有已连接账号时确定性回落到第一个启用账号，由 durable outbox 等待该账号恢复。首次解析出的私聊目标必须在事件入队前绑定到 episode，Core 重启、账号连接变化和重复检查继续使用该目标。重复入队、失败重试、Core 重启和同一 episode 内继续增长都不能重复通知；总待处理数降到 100 条或更少时清除活动 latch，下一次重新越过 100 条才建立新 episode。管理员 QQ 或同 Agent 启用账号不可用时不伪造目标、不跨 Agent 选择账号，也不把该 episode 标记为已经排入，后续队列检查仍可重试通知。

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

Dream 的工作记忆输入固定读取当前 Agent workspace 的 `WORKING_MEMORY.md`，捕获时把文档 revision 与规范化记录摘要写入当日 `dream_runs.input_json`。会话观察与实时记忆压缩共用消息资格规则，不把 internal、orchestrator decision、failed 或 running 消息作为现实聊天证据。旧 SQLite 工作记忆不迁移、不恢复到 Markdown、不删除，也不再参与新 Dream 的工作记忆选择或写回。实时记忆压缩仍不自动晋升长期记忆；Dream 对入选工作记忆给出转存动作时进入既有长期记忆 SQLite consolidation。

一次 Dream 从输入捕获、召回统计初始化、持久运行 claim、payload 与提示词构建开始，到 Provider、工作记忆、AIR、SQLite 与人格投影提交结束，共享任务入口创建的 600 秒硬预算；任何阶段、恢复或 Provider 重试都只能使用剩余时间。Runtime 停止、替换或显式取消会中止同一信号；取消后不得继续提交 Dream 状态、记忆、AIR、人格文件或操作日志，不得重新建立 tick 或重试定时器。人格文件的取消若发生在原子 rename 之后，必须恢复原 revision 内容并刷新运行时人格，不能留下迟到投影。

Dream 把记忆重放、事件边界、要义保持、提取保护、检索诱发遗忘和印象更新映射为可审计的产品流程。实时记忆压缩继续以默认 16 条新消息窗口提供高于人类睡眠周期的整理频率；每日 Dream 负责跨来源整合、久远要义、长期休眠筛选、场域约定与人格印象。宿主不根据 canonical 正文的词汇、身份、称呼、QQ、置信度、相似度或来源覆盖率阻止重写、合并与转存；快照事务、工作记忆 revision、场域知识 revision 和人格 CAS 保护持久化一致性。

长期记忆从首次进入召回统计起记录 `recallCount`、跨日召回数、最近召回时间和 tracking 起点；升级前缺少回执的历史不伪造召回次数，而是从升级后的 tracking 起点开始计算休眠期。只有出现在渲染器确认引用的提示词变量或工具结果中、所在模型轮次成功结束且回复仍有效的长期记忆才写入带 `recallKey` 的幂等 receipt；管理员模板省略记忆变量、文本碰巧相同、管理台读取、人工搜索、Dream 选择、渲染或 Provider 失败、调用取消和过期回复都不增加统计。同一模型轮次的初始上下文与工具召回按记录去重。模型请求开始前先为即将进入上下文的长期记忆写入不计数的 pending exposure；源记录已经消失时提示词请求关闭失败，工具召回则过滤该结果。Dream 在同一 `BEGIN IMMEDIATE` 事务内拒绝归档、合并或移除仍有未过期 exposure 的源，成功且仍有效的模型轮次才把 exposure 转成 receipt；未完成的 exposure 最长保留 25 小时后惰性失效，因此进程崩溃不会产生虚假召回，也不会永久阻塞整理。canonical 记忆 ID 只接受最多 128 字符的安全 ASCII；旧 ID 启动时不能导致 tracking 初始化崩溃，Dream 规范化后在整理事务内把可持久旧 ID 的 stats 与 receipts lineage 汇聚到唯一稳定目标 ID，保留最早 tracking 起点与累计实际召回。记录在 exposure 登记前已经消失时不新建 receipt 或孤儿统计。

Dream 把工作记忆与长期记忆合并为一个候选池，以本次运行时间向前 `bot.memory.dreamRecentWindowHours` 小时为分界。默认窗口为 24 小时，近期上限 24 条，更早上限 12 条，总上限 48 条；窗口允许 1—720 小时，两桶分别允许 0—48 条且合计必须为 1—48 条。近期候选优先覆盖工作状态、活动任务、未来相关性和重要事实，同分才使用运行 seed；更早候选按召回需要、重要性、未来相关性、情绪显著性、任务相关性和复审需要排序，同分再使用 seed，因此结果稳定且不会依赖输入顺序。任一时间桶不足时只使用现有记录，不从另一桶补齐；未入选记录保持原样。三项设置按 Agent 持久化并热更新，只影响随后新建的 Dream 运行；已经持久化输入的自动重试和人工恢复继续复用原 seed 与原批次，旧运行缺少窗口字段时按历史 48 小时解释。

入选记忆通过唯一的 `dream.payload` 变量一次性注入同一个 Provider 请求，在全批次中比较事件边界、因果主线和重复信息。该生产请求明确包含上段定义的原始身份；user-test 的 sample 派生流程继续在只读源上生成独立、不可逆脱敏且时间平移的夹具，隔离 workspace 不继承生产记忆、会话、AIR、任务、Director、人格材料或 workbench，生产真实数据不得进入外部 fixture。对仍处于近期窗口的事实工作记忆与长期记忆，宿主把各自的改写、合并、转存、删除或归档提案降为 retain，保证近期工作环境不被 Dream 改写、移动或删除；长期记忆合并组中只要有一条近期事实，整组原子保留。更早记忆可按同一事件或因果链压成要义。完成保留、重写、合并、转存或归档后分别写入 `dreamReviewedAt` 或 `lastReviewedAt`。读取阶段先把旧记录中的 `text/content/summary/memory` 正文、缺失或非法 ID 和旧称呼字段确定性归一为当前 v2 结构；管理台人工新增、置顶或显式受保护记录继续按其结构化标志保留。Dream 的合法重写、合并与转存直接采用模型返回的非空 canonical 正文，低置信度、不相关事件、未知称呼、额外 QQ、高风险词和低来源覆盖率都不触发宿主正文门禁。

生成输出使用精确 JSON 合同。顶层必须且只能包含 `schemaVersion`、`dream`、`longTermReviews`、`workingReviews`、`personaAdjustment` 与 `fieldKnowledge`，字段名固定为 camelCase；两个 review 数组必须对本次各自候选池中的来源 ID 完成一次且仅一次覆盖，未知、重复、遗漏或跨池 ID 均使整份输出无效。review 的字段集合、action、canonical 形状、评分范围、人格证据与场域知识证据必须完整合法，不再补 `retain`、猜测别名、填默认分数或把非法动作静默降级；`fieldKnowledgeWritable` 不是 true 时，`fieldKnowledge` 必须为 null。原始 JSON 总上限为 64,000 个 code point，Dream 正文与单个 canonical 继续各自受 4,096 上限，场域知识正文受 16,000 上限。严格解析发生在 `markGenerated` 之前；无效输出以 `DREAM_OUTPUT_CONTRACT_INVALID` 失败并保留原输入批次，15 分钟后自动重试，同一运行最多尝试 3 次。恢复 `generated` 阶段时必须从持久化 `rawOutput` 重新通过相同解析器；旧宽松输出或缺少原文的运行清空生成产物并回到模型生成阶段，不能沿用补全结果提交。第三次仍未通过时停止自动重试，管理台显示安全错误与尝试次数；错误持久化、Dream 操作日志与历史 API 只保留稳定错误码和固定安全文案，无效模型原文、Provider payload、凭据和宿主路径不能进入这些位置。提交顺序固定为工作记忆 Markdown CAS、`AIR.md` CAS、长期记忆 SQLite 事务；后一步失败时按各自提交 revision 逆序回滚已写文件，任一 revision 漂移都失败关闭。成功写入或回滚 `AIR.md`、`PREFERENCE.md` 或 `RELATION.md` 后立即热重载当前人格。Markdown 与 SQLite 无法提供跨文件系统和数据库的崩溃原子性，因此进程在步骤之间被强制终止时仍需恢复审计。

工作记忆晋升为长期记忆时使用以下不可省略的字段映射；宿主在提交事务前复核映射，任一字段缺失、错绑或与来源不一致时以 `DREAM_CONSOLIDATION_MAPPING_INVALID` 终止该运行：

| Dream 输入/输出 | 长期记忆字段 |
| --- | --- |
| `workingReviews[].canonical.fact` | `fact` |
| `workingReviews[].sourceIds` | `sourceWorkingMemoryIds` |
| 来源工作记忆的用户与称呼 | `userIds`、`addressNames` |
| 来源工作记忆的事件时间与因果键 | `occurredAt`、`occurredEndAt`、`eventKey`、`causalChainKey` |
| 本次运行与宿主生成值 | `schemaVersion=2`、稳定 `id`、`updatedAt`、`eventFingerprint`、`dreamRunId`、`consolidatedBy=sunabot.dream` |

Provider 请求继续使用文本响应格式，JSON 由提示词和宿主解析器共同约束。旧持久 Dream 模板依次通过 `dream-flex-contract-v3`、`dream-memory-contract-v5` 与 `dream-output-contract-v6` 保留式迁移；v6 在第一条 system 消息保留且仅保留一份完整精确输出合同，清除全部 system 消息中的旧宽松响应说明，只有 marker、合同残缺或合同分散时都重建完整合同，管理员自定义前后文、消息顺序、工具和响应配置保持不变，重复执行幂等。无法精确识别的自定义合同保持原样并记录迁移原因，但其运行时输出仍必须通过同一严格解析器。

管理台可为所选 Agent 手动触发当日 Dream。触发仍受 Agent、系统时区自然日唯一约束：当日尚无运行时以实际触发时间建立运行；当日失败记录可由明确的管理员操作重新取得租约并从已持久化阶段继续，即使自动重试次数已经耗尽；当日已完成或仍持有有效租约时返回冲突，不产生第二份整理结果。手动运行取得持久化 claim 后才排入管理员入睡通知，通知入队失败将当前运行标记为不可自动重试失败，防止无通知的后台补跑。

归档建议还必须达到 0.9 置信度，并且只允许重要性、未来相关性与情绪显著性均不高于 0.25，且没有活动引用、保护标记、人工置顶或唯一事件标记的长期琐事。休眠期从最近一次成功召回开始；从未成功召回时从 tracking 起点开始，基础为 90 天，每个不同召回自然日增加 30 天，增加量最多 180 天。相同自然日的重复召回只增加累计统计，不反复延长保留期；因此常被跨日使用的内容更难归档，曾经被使用但已经长期沉寂的琐事仍可遗忘。提交事务在 `BEGIN IMMEDIATE` 内精确核对当前累计召回、跨日召回、最近召回、tracking 起点、receipt 与 pending exposure 快照；审查后任何召回变化都使整次整理冲突回滚。归档完整保存原记录与原因 30 天，随后由 Dream tick 每次有界清除最多 100 条；这段保留期用于审计和恢复，不把已归档内容继续送入正常召回。

每次成功运行都新增一条 `memoryKind=dream`、`realityStatus=imagined`、`factuality=imagined` 的当日工作记忆，并写入稳定的 `eventKey=dream:<localDate>` 与事件指纹；工作记忆文档在梦境原文前显示梦境标记和本次 Dream 的实际生成整理时间。旧 Dream 只与 Dream 合并或转存，不能与事实工作记忆混合；旧 Dream 的多条合并和转存直接遵循模型 action，不要求共同事件键或因果键。人格证据构造会排除所有 Dream，并要求真实 `eventKey` 与真实会话或上下文键，不能用记录 ID、事件类型或来源字段代替独立事件和场景。每条人格证据的影响分数必须不低于 0.65；observation 要求至少两条独立事实覆盖两个上下文，stable 要求至少三条事实、两个上下文和三天跨度，core 要求至少四条事实、三个上下文和七天跨度。模型只提供稳定 `topicKey`、目标文件、温和陈述和证据 ID，由宿主计算能够满足的最高层级，不接受模型自报层级。

每个通过证据与内容安全校验的印象都作为对应 `dream_runs.persona_json` 的 applied 历史永久保留，读取时通过 `beforeLocalDate` 分页覆盖全部 Dream 运行，不受单页 100 条限制。生效范围固定为 `targetFile + topicKey`：同一范围只投影历史中的最高层级，低层级即使更晚也无条件被覆盖；处于同一最高层级的多条印象共同生效，不同主题互不覆盖。`PREFERENCE.md` 或 `RELATION.md` 只物化当前生效陈述到带宿主管理边界的“缓慢形成的倾向”区段，低层级正文不继续进入回复提示词，完整历史仍留在 SQLite。旧 applied 记录缺少主题或层级时，分别以 kind 和 stable 兼容；非法、skipped、failed、pending 记录不参与投影。每晚最多提出一条印象，只接受 4—80 字的单句、低风险、可被未来反例修正的倾向，不接受诊断、永久标签、权限、安全边界或核心身份变化，并用内容安全门与 revision CAS 防止越界修改或覆盖管理员并发编辑。

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

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图校验、重试和 OneBot 外发。`generate_img` 与 `selfie` 的全部生图参数及参考图使用意图由模型填写；当前会话 workbench 中的已有图片可通过相对路径或 Bash 实际返回的授权绝对路径直接传入。管理员私聊的 Native 绝对路径必须位于当前 Agent Native workbench，也可使用同一 Agent Docker workbench 的宿主绝对路径或 Docker Bash 返回的 `/workbench/...`；管理员群聊与普通 QQ 会话只接受 Docker `/workbench/...`，其中 `/workbench/native-workbench/...` 按既有只读投影解析到当前 Agent Native workbench。运行时先把绝对地址归一化为所属 workbench 与安全相对路径，再沿用同一描述符、根身份、文件类型和变化检测；其他宿主绝对路径、URL、媒体句柄、Base64、目录、链接、变化中的文件及非图片在该参数中全部拒绝。知识搜索正文中的 Native Markdown 图片链接必须按来源文档解析为仅含一次 `knowledge/` 前缀的 Workbench 根相对路径，正文明确标注的 Workbench 根相对路径则原样使用；两者都必须先由 Bash 核验精确文件。缺失、越界、无权、链接或不稳定参考图在异步任务创建前返回 `SELFIE_REFERENCE_*` 或 `GENERATE_IMG_REFERENCE_*` 诊断码，不得伪装成 `SEND_FILE_*`。历史消息、当前消息与最多两条明确引用消息中的图片都以 `message:<message-id>:image:<index>` 媒体句柄提供给模型，精确句柄优先于 workbench 路径、显式 URL 和来源回退。来源回退包含 `none`、`current`、`previous_output`、`history`、`current_and_history`；群聊中的自动历史只选择当前用户的媒体，精确句柄只能解析当前会话和当前捕获序列内的媒体。异步图片任务在 dispatch 时把 workbench 参考图归档为内容寻址的不可变 URL，并持久化原始路径到归档 URL 的映射；本次工具实际需要的当前、引用和历史聊天图片也必须在 dispatch 完成下载、类型与摘要校验并以原始字节写入当前 Agent 的内容寻址会话归档，远程下载执行 1 次初始请求和最多 3 次重试。队列中的聊天参考图只保存 schema v1 的 SHA-256 与不可变归档 URL，工具参数和入站快照只能引用归档 URL，不能保存远程 URL、Base64 或附件缓存路径。旧任务没有聊天快照时按原捕获序列重建。模型显式提交的任一媒体句柄无法解析、必需参考图无法下载或归档、归档在 Provider 输入阶段无法形成对应数量的 `input_image` 时，图片任务必须在调用图像 Provider 前明确失败，不能丢弃参考图后继续纯文字生图。`selfie` 成功后由异步完成回调把生成图片直接加入 `assistant_reply` 并交给 OneBot 媒体出站，模型不得再次调用 `send_file` 或猜测生成文件路径；发送前生成文件缺失必须以 `OUTBOUND_MEDIA_SOURCE_MISSING` 失败，不能记录或回复伪造成功。聊天中的 `generate_img` 与 `selfie` 成功结果、管理台 playground 结果都写入当前 Agent 的 SQLite 图片历史。升级到 SQLite-only 图片历史时，运行时首次初始化按 Agent 扫描受控生成 PNG 并一次性回填缺失元数据，跳过 `emoji-*`、符号链接和其他文件；之后列表请求只读取 SQLite。历史生成图与会话图片归档的 `/generated-images/` 路径只允许生成图片根目录下的受控结构；文本模型视觉输入由受控原图生成最长边 2048 的有界 Data URL 副本，图像 Provider 参考输入从同一受控原件生成最长边 3840、最多 8,294,400 像素、最多 16 MiB 的高保真 JPEG 或 PNG Data URL，两个派生管线均不覆盖内容寻址原件。会话图片归档位于 `conversation-assets/agents/<agentId>/<sha256>.<ext>`，不进入生成图片历史。聊天回复中实际发送成功的 `emoji-<sha256>.png` 或 `emoji-<sha256>.gif` 表情把已校验字节对应的不可变会话归档 URL 写入 assistant 会话媒体，在后续上下文中提供精确句柄，并可由 `generate_img` 或 `selfie` 作为参考图；原始表情 workbench URL、宿主路径和 Base64 不进入会话消息。表情仍不进入 SQLite 生成图片历史，纯表情记录仍不进入记忆队列或记忆压缩。表情媒体在内部有序内容段中标记为 `sticker`，跨 Core/NapCat 继续传输受控图片字节并映射为 OneBot `image` + `sub_type=1`；普通生成图不携带该 subtype。自拍始终使用当前 Agent 的角色参考图与 `selfie_prompt_rewrite.json`；primary Plana 在新建、缺失或空白文件及渲染回退时使用普拉娜专用改写模板，所有其他 Agent 在相同路径使用只依赖当前人格与角色参考图的通用模板。当前 Agent workspace 的 `workbench/selfie/` 与 `docker-workbench/selfie/` 是两套各自最多 9 张的带备注素材库，每张图片必须具有可编辑备注；节点合并两套 `{id,note}` 元数据，按内容 ID 去重并严格选择 1—3 张。每套 `references.jsonl` 每行保存一个 schemaVersion 1 的 `{id,fileName,note}` 记录，与目录一致时只读取所选图片并保持节点返回顺序；零字节或单个结尾换行表示空图库。管理员私聊 `import_chat_selfie` 写 Native，管理员群聊写 Docker；管理 API 可按 Workbench 独立寻址。升级迁移先在旧 `selfie/` 完成 JSONL 转换，再把完整目录移入 Native workbench，并为 Docker Workbench 补齐独立空入口。外部参考图最多额外保留 1 张，并紧接已选择的 1—3 张自拍素材追加为实际最后一项，不填充空槽位；单次生图总参考数仍不超过 4。节点空选、未知、重复或超量 ID 时不得截断、随机回退或继续生图。管理台可在图像页上传、预览、编辑备注和删除素材；列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件与内容寻址会话图片归档保存在忽略的运行目录，图片历史和会话消息元数据保存在主 SQLite 数据库。

其中知识图片路径遵循 5.4 的单一合同：Markdown 图片链接解析为恰好一个 `knowledge/` 前缀，显式 Workbench 根相对路径原样使用；缺少真实链接、未完成 Bash 核验、重复前缀或猜测出的路径都不能派发图片任务。

生图工具的 `size` 是最终落盘像素合同。Provider 返回尺寸与请求不一致时，结果写入器必须按请求宽高居中裁切并使用高质量重采样，随后保存为精确尺寸 PNG；4K 竖图必须实际为 2160×3840，4K 横图必须实际为 3840×2160，不能只在日志或 `revisedPrompt` 中记录请求尺寸。

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
