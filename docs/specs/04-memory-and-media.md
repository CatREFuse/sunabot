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

记忆 Provider 的正文提示统一优先采用当前 Agent 的第一视角，并显式参考 `SOUL.md`、`PREFERENCE.md`、`USER.md` 与 `RELATION.md`。工作记忆、长期记忆、用户画像和 Dream canonical 的第一人称、句首、回忆提示语及用户自述改写都只作为提示词写作偏好，不使用固定句首或关键词正则做宿主拒绝条件。主观内容仍必须有聊天事实、既有关系或角色人格依据，不能虚构强烈情绪。

记忆正文只保留少量概括信息。完整工作记忆通常为 3—6 条、最多 8 条；长期记忆整理结果通常为 3—8 条；每位用户仍只保留一条画像记录，正文通常只含 1—3 个最影响未来相处的稳定认知。即使每条信息本身清晰，也必须主动把语义相同、相近、重复、互为因果或属于同一事件不同阶段的内容压缩为一条，正文保留原因、先后变化和最新状态；事件合并以 `occurredAt` 保留最早起点、以 `occurredEndAt` 保留最新结果或结束时间，画像的 `time` 保留依据从早到晚的关系。已经结束且不再影响未来的小事应删除。

提示词建议 `fact` 使用自然叙述，避免列表、字段标签、分类标题、来源说明、压缩说明或 `事实：`、`情绪：`、`认知：`、`相关用户：` 等模板化前缀，并建议用称呼与 QQ 帮助模型理解人物。宿主不检查正文中的第一人称、称呼、QQ、邻接关系、固定词汇、情绪或表达格式，也不据此拒绝或改写记忆。用户画像以宿主绑定的 `userId` 保存 QQ，以模型返回或当前消息提供的 `userName` 保存显示名，以 `addressNames` 保存去重后的称呼数组。旧 `addressName`、`address_name` 与 `salutation` 在读取或画像合并时归一化为 `addressNames`，新记录只持久化数组。严格 JSON envelope、稳定 ID、来源边界、时间字段、事件键、来源工作记忆 ID 和事务语义保持不变。

用户画像 Provider 的提示词要求逐条参考本批 `messages` 和 `previousProfiles.addressNames`，输出当前用户的聚合画像。宿主只把画像绑定到当前会话参与者：私聊可在模型遗漏或误写可选 QQ 元数据时回落到唯一当前用户，群聊必须能从结构化 `userId` 唯一确定当前参与者。称呼、显示名和正文按模型返回保存，不检查其是否在消息中出现，也不检查正文中的称呼—QQ 配对。工作记忆的可选 QQ 或因果键元数据无效时忽略该可选字段，正文仍进入完整集合。同一合法 JSON envelope 中的空正文条目或无法安全绑定当前参与者的画像条目只跳过该条并记录操作历史，其余画像和工作记忆继续提交；合法空工作记忆集合直接替换为零条，兼容字段 `allPreviousMemoriesInvalidated` 不参与宿主写入裁决。只有顶层 JSON/数组结构无法解析或持久化事务冲突时保留该来源旧值。`memory.compress-out` 保留为可编辑提示词目录和旧模板迁移兼容入口，不额外触发实时 Provider 调用。

`WORKING_MEMORY.md` 中每个事项必须显式显示宿主记录时间、IANA 时区、完整会话来源 ID、scope、可用的会话标题和来源类型。记录时间由宿主以系统 IANA 时区生成并包含当时 UTC offset；正文表达的事件时间可以保留为 `occurredAt`/`occurredEndAt`，不能替代记录时间。模型返回和 `add_workmemory` 参数都不能指定持久化记录时间、时区、Agent 或会话来源。直接编辑 Markdown 正文会保留原事项的宿主元数据，显示元数据与宿主元数据不一致时整份文档拒绝读取。

工作记忆文档最多 64 KiB，只接受普通文件并拒绝 workspace 或目标符号链接。读取使用 no-follow 文件句柄；写入使用同目录 0600 临时文件、revision CAS、内容完整回读校验与原子 rename。模型整批结果在 Provider 成功并解析出规定结构后直接渲染，宿主补充当前 Agent、会话、记录时间与来源元数据；正文中的身份、称呼、QQ、因果、第一人称、词汇、情绪、置信度和来源覆盖率均不参与写入裁决。数组中的空正文条目单独忽略，合法空数组允许清空；顶层解析失败、文档超限、宿主元数据不一致、revision 冲突或文件安全失败时保留旧文档。`add_workmemory` 只接收正文，由宿主追加并沿用相同大小、文件类型、revision 与原子替换条件，不执行正文语义检查或自动改写。

管理 API 读取单个工作记忆来源时，同时返回当前 Agent 的完整 `WORKING_MEMORY.md` 正文、文件名和 revision；不返回宿主绝对路径。管理台直接以一份 Markdown 文档显示工作记忆，保持文件顺序、标题、记录时间、会话来源和正文，不把事项拆成管理台列表。宿主使用的文档版本与事项 metadata HTML 注释只在阅读视图隐藏，API 原文和磁盘文件保持逐字一致。工作记忆页不提供逐条排序、筛选、召回、分页、新增、编辑或删除入口；长期记忆、用户画像与 Dream 的列表和操作保持各自合同。

工作记忆、长期记忆、用户画像、召回与 Dream 的操作历史统一写入当前 Agent 业务库的 `request_logs`，固定使用 `category=memory.operation`。事件只保存宿主时间、Agent、来源、操作、执行者、结果、稳定原因码、可用的 batch/conversation/record 标识、前后数量与 revision，不保存记忆正文、模型原始输出、秘密或宿主绝对路径。工作记忆追加与替换、`add_workmemory` 每轮已调用或未调用的模型决定、SQLite CRUD、自动批次逐原因验证与提交、召回查询、pending exposure、receipt 和 Dream 阶段都必须产生对应事件；Agent 路由与业务库保持一一对应。成功业务写入之后审计追加失败不能回滚已提交的记忆，必须输出稳定的审计失败日志。该类别只记录上线后的新操作，不回填历史。

`GET /api/memory/operations?agentId=<id>&page=<n>&pageSize=<1..100>` 只从所选 Agent 业务库读取 `category=memory.operation`，按宿主时间从新到旧分页返回，不混入其他请求日志。管理台记忆页始终提供“操作日志”入口，以侧边时间线显示记忆类型、操作、执行者、结果、时间、会话来源、数量变化与原因码；batch、record 和 revision 放在可展开的技术信息中。切换 Agent 时关闭侧栏、清空旧结果并取消旧请求，迟到响应不能覆盖当前 Agent。

工作记忆与长期记忆的 strict 输出都包含 nullable `causalChainKey`。提示词建议只在明确共享原因、转折与结果时复用 `causal:` 键，无法确认时返回 `null`。运行时同时接受 camelCase 与 snake_case 输入；空串、数组、越界或格式非法值作为无效可选元数据忽略，不影响同条非空正文写入。`memory-perspective-v6` 一次性迁移会把已知旧标准提示词升级为当前合同，把工作记忆、长期记忆和用户画像中的第一人称、称呼与 QQ 固定格式调整为写作建议；识别只使用迁移版本、结构化模板 ID、官方当前模板完整指纹及已知旧版本精确内容，不扫描第一人称、感受、看法、称呼或 QQ 等自然语言关键词。迁移保留管理员段落、其他消息、工具与 schema description；完全自定义或无法可靠识别的兼容模板保持原样、记录稳定原因并继续启动。

既有记忆重整时，提案提示词可以约束视角、句首、回忆提示语、直接引语、字段标签、称呼和 QQ 写法，安装器不扫描或裁决这些正文内容。signed 提案仍需绑定当前 Agent、来源行、稳定目标 ID、结构化用户 ID、数量、时间与不可变来源元数据。旧 `memory-perspective-v1` signed 提案或计划不满足当前结构合同时必须重新生成、签名并刷新。事件时间只能由证据确定性聚合，不能由提案任意改写或通过 `preserveFromBase` 覆盖。维护操作必须在 Core 完全停止后创建覆盖默认 Agent 与全部其他 Agent 业务库、队列库的可恢复备份并完成校验；参数化事务只在由该恢复点创建的完整 staging 副本中替换 `memory_records`，生产侧通过可重入 data 目录 journal 安装已全量验证的数据库集合，不能修改会话、队列、请求日志或其他业务表。重整后必须核对每个 Agent、每类来源的前后数量、样本、完整 row shape、`integrity_check`、queue 不变量和恢复能力。

### 5.2 调度

记忆调度器按会话保存待处理消息、当前批次、失败次数和自上次尝试后新增的消息数。消息窗口由 `bot.memory.messageThreshold` 控制，默认值为 48，可通过管理台“记忆处理”的“压缩阈值”热更新；阈值变化后运行时必须立即按新值重新检查已排队消息。每累计一个完整消息窗口获得一次压缩尝试，不因静默时间触发不足窗口的部分批次，也不按时间自动重试失败批次。失败批次保留原消息，下一组完整窗口到达后才允许再次尝试；服务重启不额外增加尝试额度。已提交游标之前的消息不能重复入队。

`user_group` 与 `bot_group` 只把实际发送并成功落入会话记录的 Bot `assistant` 消息作为记忆锚点。调度器在按序排列的可见、可记忆消息流中，选取每个锚点自身、锚点之前至多 20 条和之后至多 20 条消息的并集；第 21 条不进入候选，重叠窗口按稳定消息标识去重。锚点后的消息在到达时逐条补入 20 条范围，没有锚点或位于全部锚点窗口外的群聊消息不进入待处理队列，也不增加压缩或失败重试额度。`private` 仍处理全部可记忆消息；`bot.memory.messageThreshold` 的完整窗口规则作用于筛选后的群聊候选，因此单个完整锚点窗口最多 41 条，在默认阈值 48 下需要等待后续锚点窗口继续累计。

升级后的旧群聊调度状态只有在调用方显式声明输入为完整 retained history 时，才能在允许 claim 前按相同锚点规则原子重建并写入新选择策略；增量历史或缺少该声明时必须保持 legacy 未调和并禁止 claim。旧 `currentBatch` 内仍符合新规则的消息继续视为已经消费过尝试额度；未提交的 failed/running 批次清除旧 batch 与失败状态后，只有不属于旧 batch 的新候选才能增加重试额度，重启不能返还已消费额度。已提交批次只完成游标结算，不能再次调用记忆 Provider，已提交的历史记忆不回溯删除。调度器只额外保留最多 41 条有界群聊选择上下文，用于跨重启补齐未来 Bot 锚点之前和之后的消息，不把该上下文本身计入候选或触发额度。畸形选择上下文必须撤销当前策略并失败关闭，直至重新以完整历史调和；合法但超限、无序或重复的上下文在加载时确定性归一化为最近 41 条。

工作记忆与用户画像的 Provider 调用使用单次 120 秒传输预算，并由 135 秒外层总预算负责取消与清理，不在同一压缩额度内启动第二次传输。超时或失败继续沿用上述批次保留和完整窗口重试规则；内部超时调整不能增加压缩尝试额度、重复提交批次或触发静默时间重试。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆 Markdown、长期记忆 SQLite 和用户画像 SQLite 中搜索。人物检索与召回提示只使用 QQ 和 `addressNames`，`userName` 不参与语义检索或提示身份展示。工作记忆提示内容同时呈现宿主记录时间与会话来源；长期记忆和用户画像继续由 SQLite 持久化并有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

### 5.4 Agent 知识库

每个 Agent 的资料根目录固定为自身 workspace 下的 `knowledge/`，支持任意层级目录并递归扫描 `.jsonl`、`.md`、`.markdown` 与 `.txt` 普通文件；符号链接、硬链接、特殊文件和未知扩展名不进入索引。JSONL 按每个非空物理行独立分段，Markdown 与文本按空行分隔的自然段分段，并为每段保存从 1 开始的原始行号范围。单文件最多 8 MiB、单 Agent 最多 10,000 个文件、目录深度最多 32 层；UTF-8、文件身份或读取边界异常时，该文件以稳定错误状态进入清单且不产生检索分段。

检索索引位于 `workspace/cache/knowledge/<agentId>.sqlite`，使用 FTS5 外部内容表和 BM25 排序，并为中英文正文和相对路径生成确定性检索 token。索引只保存可从资料树重建的文件元数据与分段，不属于业务恢复点；文件大小、mtime 或 ctime 变化时增量重建，管理员可显式全量重建。`knowledge_search` 只绑定当前 Agent，返回相对路径、精确行号和最多 4,000 字符的有界正文。

### 5.5 场域知识

场域知识是当前角色可编辑的人格片段，不属于工作记忆、长期记忆、用户画像或 Agent 资料库。它保存在当前 Agent workspace 的 `AIR.md`，记录一个实时社交场域中默认知道但不会每轮重述的内容，包括会话范围、昵称与身份映射、小团体黑话和内部梗、共同话题与近期事件、关系亲疏与冲突变化、气氛和幽默边界、明确禁忌、群规、临时约定、礼节，以及公共流行语的语气、更新时间、失效状态与纠错信息。

明确表达的“不要做某事”“讨厌某事”“请这样称呼我”和“这个梗在这里表示某意思”必须作为强证据保留；无人解释但反复出现的模式只能标为低置信观察。公共热梗与单个会话私梗分区保存，所有私聊、用户群聊和 Bot 群聊条目都必须携带范围，不能跨场域传播。公共语境只提供理解基线，允许识别惩罚性或暴力意象的戏谑表达，但不能把玩笑升级为真实行动，也不能用热梗替代用户在当前场域中的明确纠正。

`read_air` 调用使用独立模型请求把原有场域知识、最新聊天记录和角色注入理解合并成完整替换稿。工具写入不追加增长型历史，不使用 JSON/JSONL 或业务 SQLite；`AIR.md` 与其他人格 Markdown 一样属于小型配置文件。文件写入使用 64 KiB 上限、符号链接拒绝、revision CAS、串行队列和原子替换，成功后热重载当前人格；模型请求、工具调用和成功或失败结果进入请求日志，但不得把秘密或宿主绝对路径写入日志。

### 5.6 每日 Dream

Dream 的工作记忆输入固定读取当前 Agent workspace 的 `WORKING_MEMORY.md`，捕获时把文档 revision 与规范化记录摘要写入当日 `dream_runs.input_json`。旧 SQLite 工作记忆不迁移、不恢复到 Markdown、不删除，也不再参与新 Dream 的工作记忆选择或写回。实时记忆压缩仍不自动晋升长期记忆；Dream 对入选工作记忆给出转存动作时进入既有长期记忆 SQLite consolidation。

Dream 把睡眠研究中的记忆重放、显著信息筛选、旧记忆整合、要义抽取、联想式未来模拟和情绪调节映射为可审计的产品流程：近期与久远材料交错入选，模型在提示词中判断重复事件、因果主线和需要转存的信息。宿主不根据 canonical 正文的词汇、身份、称呼、QQ、置信度、相似度或来源覆盖率阻止重写、合并与转存；快照事务、工作记忆 revision 和人格 CAS 继续保护持久化一致性。

长期记忆从首次进入召回统计起记录 `recallCount`、跨日召回数、最近召回时间和 tracking 起点；升级前的历史不反推为零召回。只有出现在渲染器确认引用的提示词变量或工具结果中、所在模型轮次成功结束且回复仍有效的长期记忆才写入带 `recallKey` 的幂等 receipt；管理员模板省略记忆变量、文本碰巧相同、管理台读取、人工搜索、Dream 选择、渲染或 Provider 失败、调用取消和过期回复都不增加统计。同一模型轮次的初始上下文与工具召回按记录去重。模型请求开始前先为即将进入上下文的长期记忆写入不计数的 pending exposure；源记录已经消失时提示词请求关闭失败，工具召回则过滤该结果。Dream 在同一 `BEGIN IMMEDIATE` 事务内拒绝归档、合并或移除仍有未过期 exposure 的源，成功且仍有效的模型轮次才把 exposure 转成 receipt；未完成的 exposure 最长保留 25 小时后惰性失效，因此进程崩溃不会产生虚假召回，也不会永久阻塞整理。canonical 记忆 ID 只接受最多 128 字符的安全 ASCII；旧 ID 启动时不能导致 tracking 初始化崩溃，Dream 规范化后在整理事务内把可持久旧 ID 的 stats 与 receipts lineage 汇聚到唯一稳定目标 ID，保留最早 tracking 起点与累计实际召回。记录在 exposure 登记前已经消失时不新建 receipt 或孤儿统计。

Dream 把工作记忆与长期记忆合并为一个候选池，以本次运行时间向前 `bot.memory.dreamRecentWindowHours` 小时为分界，使用运行 seed 对候选做无放回随机排序：近期最多抽取 `dreamRecentMemoryLimit` 条，更早记忆最多抽取 `dreamOlderMemoryLimit` 条；默认值分别为 48、12、12，窗口允许 1—720 小时，两桶分别允许 0—24 条且合计必须为 1—24 条。三项设置按 Agent 持久化并热更新，只影响随后新建的 Dream 运行；已经持久化输入的自动重试和人工恢复继续复用原 seed 与原批次。任一时间桶不足时只使用现有记录，不从另一桶补齐。最多 24 条入选记忆通过唯一的 `dream.payload` 变量一次性注入同一个 Provider 请求，在全批次中比较重复事件、相同因果与可合并信息；工作记忆和长期记忆仅因持久化动作不同而保留分组，不启动逐条模型调用。完成保留、重写、合并、转存或归档后分别写入 `dreamReviewedAt` 或 `lastReviewedAt`。读取阶段先把旧记录中的 `text/content/summary/memory` 正文、缺失或非法 ID 和旧称呼字段确定性归一为当前 v2 结构；管理台人工新增、置顶或显式受保护记录继续按其结构化标志保留。Dream 的重写、合并与转存直接采用模型返回的非空 canonical 正文，低置信度、不相关事件、未知称呼、额外 QQ、高风险词和低来源覆盖率都不触发宿主正文门禁。生成输出采用柔性合同：宿主保留有界原始输出并尽力从 JSON、普通文本、camelCase、snake_case 与对象键映射中提取内容；未知或重复 ID 被忽略，遗漏来源自动补 `retain`，缺字段与非法评分使用保守默认值，不可执行 action 或 canonical 降级为 `retain`，无效人格建议跳过，任何这类生成格式问题都不使 Dream 失败。宿主只对进入代码写入的动作、归档策略、人格证据、factual/imagined 边界与持久化一致性执行硬性协议；工作记忆结果先以持久化 revision 做 Markdown CAS，revision 漂移时在任何 SQLite consolidation 前失败关闭。长期记忆、归档、召回 lineage、审查分数和运行阶段仍在单个 SQLite 事务提交，事务侧显式跳过历史 SQLite 工作记忆；事务失败或长期记忆快照冲突时，宿主使用 Dream 写入后的 revision 把 Markdown 精确回滚到捕获内容，并在回滚 CAS 冲突时停止运行。Markdown 与 SQLite 无法提供跨文件系统和数据库的崩溃原子性，因此不宣称进程在两步之间被强制终止时自动回滚。

Provider 请求使用文本响应格式，提示词中的 JSON 只描述首选形状。旧持久 Dream 模板通过 `dream-flex-contract-v3` 保留式迁移只替换 `response_format`，保留管理员自定义提示词正文、消息顺序与工具。重复、未知、遗漏或交叉复用 ID 不再触发完整分区失败；宿主按可执行来源安全降级，并把原始生成内容随 Dream 输出持久化，供后续格式清洗与审计读取。

管理台可为所选 Agent 手动触发当日 Dream。触发仍受 Agent、系统时区自然日唯一约束：当日尚无运行时以实际触发时间建立运行；当日失败记录可由明确的管理员操作重新取得租约并从已持久化阶段继续，即使自动重试次数已经耗尽；当日已完成或仍持有有效租约时返回冲突，不产生第二份整理结果。手动运行取得持久化 claim 后才排入管理员入睡通知，通知入队失败将当前运行标记为不可自动重试失败，防止无通知的后台补跑。

归档建议还必须达到 0.9 置信度，并且仅允许 tracking 满 90 天、实际召回为零、重要性、未来相关性与情绪显著性均不高于 0.25，且没有活动引用、保护标记、人工置顶或唯一事件标记的长期记忆。提交事务在 `BEGIN IMMEDIATE` 内再次核对当前 `recallCount=0`、不存在 recall receipt 且 tracking 起点与审查快照一致；审查后发生真实召回时整次整理按快照冲突回滚。归档完整保存原记录与原因 30 天，随后由 Dream tick 每次有界清除最多 100 条；这段保留期用于审计和恢复，不把已归档内容继续送入正常召回。

每次成功运行都新增一条 `memoryKind=dream`、`realityStatus=imagined`、`factuality=imagined` 的当日工作记忆，并写入稳定的 `eventKey=dream:<localDate>` 与事件指纹。旧 Dream 只与 Dream 合并或转存，不能与事实工作记忆混合；旧 Dream 的多条合并和转存直接遵循模型 action，不要求共同事件键或因果键。人格证据构造会排除所有 Dream，并要求真实 `eventKey` 与真实会话或上下文键，不能用记录 ID、事件类型或来源字段代替独立事件和场景。每条人格证据的影响分数还必须不低于 0.65，且至少三条真实、互不重复的独立事件覆盖至少两个上下文和至少 14 天，距离上次成功微调至少 30 天；每晚最多修改一个目标文件，只接受最多 80 字的一条温和倾向，并用内容安全门与 revision CAS 防止越界修改或覆盖管理员并发编辑。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- `.docx`、`.pptx`、`.xlsx`、`.odt`、`.odp` 与 `.ods` 正文由锁定的纯 Node `officeparser` 解析；同一解析器可通过 `npm run office:read -- <path> --to=text` 在 Bash 中直接使用，不依赖 GUI、桌面 Office、Python 或 Java。
- 旧版二进制 `.doc`、`.ppt` 与 `.xls` 不再通过外部 Office 套件转换，统一提示另存为现代格式；演示文稿保留分节正文和 `officeparser` AST 暴露的幻灯片数，不生成视觉页。图片页会计入页数；完全空白且未被解析器暴露为 slide 节点的页面可能少计，不使用可选元数据推测页数。PDF 与图片继续提供视觉上下文。
- 附件 artifact manifest 保持 `version: 1`，Office 解析结果另带 `parserRevision: 2`。缺少当前 revision 的既有 `.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.odp/.ods` `ready` 或 `partial` 缓存必须重解析；PDF、图片和文本缓存不受 Office revision 影响。
- Office 正文解析在独立 Node worker 进程组中执行，默认最多并发 2 个任务、单任务 90 秒、V8 old-space 768 MiB、IPC 1 MiB、工作目录 1 GiB、进程组 RSS 1.5 GiB；任一上限命中后固定保留首个错误并按 TERM→KILL 有界终止整个进程组。工作目录与 RSS 探针各自独立收敛，单个或两个探针失败都不能提前解除另一资源门禁或总超时；探针 callback、进程组信号和 fallback signal 抛错必须被消费并进入有界 stderr，不能产生未处理 Promise rejection。
- 原文件按内容哈希进入附件缓存。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

OneBot 入站图片的媒体数组保持原消息中的可用地址顺序，正文使用同序号的 `[内容图片#N：摘要]` 或 `[表情图片#N：摘要]`。内容图片参与事实理解和后续受控媒体句柄解析；表情图片只提供情绪、语气与交流意图线索，除非用户明确要求分析该表情本身。合并转发聊天记录中的嵌套图片使用同一分类和媒体序号规则，并随展开后的发送者与消息顺序进入会话。

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图压缩、重试和 OneBot 外发。`generate_img` 与 `selfie` 的全部生图参数及聊天参考图使用意图由模型填写；历史消息中的图片以 `message:<message-id>:image:<index>` 媒体句柄提供给模型，精确句柄优先于显式 URL 和来源回退。来源回退包含 `none`、`current`、`previous_output`、`history`、`current_and_history`；群聊中的自动历史只选择当前用户的媒体，精确句柄只能解析当前会话和当前捕获序列内的媒体。异步图片任务持久化 dispatch 时的媒体映射快照，旧任务没有快照时按原捕获序列重建。聊天中的 `generate_img` 与 `selfie` 成功结果、管理台 playground 结果都写入当前 Agent 的 SQLite 图片历史。升级到 SQLite-only 图片历史时，运行时首次初始化按 Agent 扫描受控生成 PNG 并一次性回填缺失元数据，跳过 `emoji-*`、符号链接和其他文件；之后列表请求只读取 SQLite。历史生成图的 `/generated-images/` 路径只允许生成图片根目录下的受控 PNG 文件，并在进入模型前转为规范化 Data URL；聊天回复中发送的 `emoji-<sha256>.png` 表情不写入 assistant 的生成图片 URL、图片历史或后续生图参考集合，纯表情回复也不创建 assistant 会话记录。表情媒体在内部有序内容段中标记为 `sticker`，跨 Core/NapCat 继续传输受控图片字节并映射为 OneBot `image` + `sub_type=1`；普通生成图不携带该 subtype。自拍始终使用当前 Agent 的角色参考图与 `selfie_prompt_rewrite.json`；primary Plana 在新建、缺失或空白文件及渲染回退时使用普拉娜专用改写模板，所有其他 Agent 在相同路径使用只依赖当前人格与角色参考图的通用模板。当前 Agent workspace 的 `selfie/` 是最多 9 张的带备注素材库，每张图片必须具有可编辑备注；节点先读取全部 `{id,note}` 元数据，再严格选择 1—3 张。`references.json` 与目录一致的正常路径只读取所选图片并保持节点返回顺序；缺少或不一致的旧目录先执行有界内容哈希兼容扫描，管理台读取后把确定性备注持久化为清单。聊天参考图最多额外保留 1 张，并紧接已选择的 1—3 张自拍素材追加为实际最后一项，不填充空槽位；单次生图总参考数仍不超过 4。节点空选、未知、重复或超量 ID 时不得截断、随机回退或继续生图。管理台可在图像页上传、预览、编辑备注和删除素材；列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件保存在忽略的运行目录，图片历史元数据保存在主 SQLite 数据库。

自拍改写的 Provider strict JSON schema 只使用目标 Provider 支持的关键字，不在数组节点提交 `uniqueItems`。既有 `selfie_prompt_rewrite.json` 通过一次性保留式迁移只移除该关键字，管理员自定义正文与其他 schema 字段保持不变；节点空选、未知、重复或超量 ID 继续由运行时解码器严格拒绝。

出站媒体必须先通过生成图片根目录、直接子文件、PNG 文件名、常规文件和大小校验，再读取为 OneBot `base64://` 内联数据。Native Core 与 Docker Core 使用同一传输方式，NapCat 不读取 Core workspace，不接受共享绝对路径。超过 OneBot 内联预算的文件必须使用独立、鉴权、限流、可过期的传输协议；不能用容器路径或宿主路径作为降级。

每个 Agent 的表情图库最多保留 64 个 key，内置的 11 个预设 key 只作为管理台生成入口，不代表图片已经存在。key 必须先在原始 Unicode 上拒绝 C0/C1 控制字符、方括号、斜杠、反斜杠、replacement character 和孤立代理项，再执行 trim 与 NFC；结果要求 1—24 个 Unicode code point、最多 64 UTF-8 字节。上传只接受最大 8 MiB 的 PNG、JPEG 或 WebP；一键生成在调用 Provider 前必须取得当前 Agent 至少 1 张有效自拍参考图，最多使用 3 张，零张或不可读时返回可重试结果并保持 Provider、文件与数据库零写。上传与生图结果统一旋转、裁切并规范化为 1024×1024 内容寻址 PNG，文件名固定为 `emoji-<sha256>.png`，规范化文件最多 16 MiB；SQLite `emojis` 行保存 key、文件名、来源、字节数、尺寸和时间。

提示词 key 列表只执行 SQLite 字段、内容寻址文件名、普通非符号链接文件与记录字节数的廉价候选检查，不同步读取或哈希最多 64 张图片；未被本轮选中的损坏文件不能阻断回复。API 列表、内容读取和本轮实际命中的唯一资产使用最多并发 2、最多等待 2 的异步完整性门禁，以 `O_NOFOLLOW` 打开同一文件句柄，复验完整父目录身份、fstat、大小、PNG 结构、1024×1024 解码、流式 SHA-256 与读后身份；dev、ino、size、mtime、ctime 未变时复用有界缓存，指纹变化必须重验。无效记录在列表中隐藏，命中无效资产时在 durable outbox 前失败关闭；延迟 OneBot 投递再次核对内容寻址摘要。

生成门禁按 Agent 最多并行 2 个 key，同 key 在途返回 409，容量耗尽返回 429；上传与生成的规范化门禁按 Agent 最多并行 2 个且不排队，admission 必须早于上传 Base64 解析或生成文件读取，容量耗尽返回 429。409/429 均提供明确状态，429 携带 `Retry-After`，所有 slot 在成功或异常的 finally 中释放。目录创建与最终内容寻址文件发布使用 parent-bound 操作；父目录、最终目标或 worker 绑定后发生替换时，外部路径和 SQLite 都保持零写。

NapCat 上报的 QQ 文件优先通过 OneBot action 返回的受控 URL 进入 Core；统一启动器固定开启 `get_file` Base64 回退。仅返回 NapCat 容器内路径时不能由 Core 直接打开，也不能为兼容该路径而挂载业务 workspace；超过现有 action 预算的文件使用后续明确的流式协议。

### 6.3 Agent workbench 文本文件

每个 Agent 的 `workbench/` 是 `read_file`、`write_file` 与 Bash 共用的私有文件边界。文件工具只处理 well-formed UTF-16、NFC 规范化的 POSIX 相对路径，路径最长 1024 UTF-8 字节，单段最长 255 字节；绝对路径、反斜杠、空段、`.`、`..`、lone surrogate、NFD、C0/C1 控制字符、符号链接、非普通文件、多个硬链接和跨 Agent 路径全部拒绝。大小写与 Unicode replacement character 不折叠或替换。读取上限为 1 MiB，并另以 262,144 个 JavaScript 字符限制模型输出；UTF-8 使用 fatal decoder，文件开头的三字节 BOM 保留为正文首字符 `U+FEFF` 并计入 `byteLength`，无 BOM 正文不变。读取使用 `O_NOFOLLOW` 的同一描述符，在读前、读后及路径复验之间核对根目录、父链、设备、inode、ctime、mtime、大小和链接数，文件在检查后增长时最多读取上限加一个字节后拒绝。

`write_file` 不创建父目录，只能在已经存在且身份稳定的安全目录中发布完整文本。正文先拒绝 lone surrogate 并执行字符与 UTF-8 字节预算校验，不改变正文的 Unicode normalization form；随后写入同目录随机 0600 临时文件，循环写完并 fsync，再从同一描述符冻结设备、inode、ctime、mtime、大小、权限、链接数、SHA-256 与实际正文。`afterTempSynced` 和 `beforePublish` 检查点都位于最终复验之前；发布前重新以 `O_RDONLY | O_NOFOLLOW` 打开临时文件，用同一描述符有界读取并核对路径身份、完整冻结快照、摘要和正文。无覆盖创建通过硬链接发布保证目标不存在，覆盖通过同文件系统 rename 原子替换，随后再次 fsync 目录，并从目标描述符复验安全身份、摘要和正文。失败时清理自身临时路径，错误响应和请求日志只保留稳定错误码、相对路径及大小，不包含正文、宿主绝对路径或文件系统错误元数据。

五种 Provider 协议写入模型请求日志前，必须对日志副本执行 action-aware copy-on-write 投影，实际 SDK request 对象与 fetch JSON 字节保持不变。Responses、Codex Responses、Chat Completions、Anthropic Messages 与 Gemini generateContent 的 `read_file`/`write_file` call 参数只记录 canonical 相对路径或 `[invalid]`；写入参数另记录 `overwrite`、UTF-8 `contentByteLength` 与固定 `[REDACTED]`，不记录正文、额外字段、宿主路径或无密钥摘要。`read_file` result 只保留安全的 `ok`、路径、字节数和固定正文占位，无法解析的结果整块替换为固定占位；`write_file` result 不记录正文。投影只识别各协议真实 call/result lineage，普通 user 与 assistant 文本即使形似工具 JSON 也保持原文。日志入口必须先在不读取 accessor 的前提下生成 inert plain-data 副本；任一 getter、Proxy、`toJSON`、循环引用、BigInt、自定义原型或序列化异常都把整份 request 日志替换为固定无敏感信息摘要，禁止回退原始 request，也不能阻断后续 SDK 或 fetch 请求。

### 6.4 会话文件、图片与语音外发

`send_file` 只向管理员触发工具调用的当前单聊或群聊发送当前 Agent `workbench/` 中的文件，不接收 QQ 号、群号或账号参数。管理员可在私聊或群聊使用；普通私聊用户、普通群成员和伪造调用不能获得 Provider port，运行时 queue 必须在文件解析前再次拒绝并保持零 outbox。真实 OneBot parser 保留既有 `transport` 缺省值，只有显式 `web` transport 被拒绝；持久目标始终规范化为 `onebot`。调用保留当前 `account_id`，缺省账号必须冻结并传递为显式 `primary`，禁止 OneBot 回退到唯一 secondary socket；群聊不能转成私聊，单聊不能改投其他用户。durable path 统一使用 POSIX `/`，queue 与 decoder 均拒绝反斜杠、绝对路径、空段、`.`、`..`。发送前必须拒绝符号链接、多个硬链接、非常规文件、非法文件名和超过 32 MiB 内联预算的内容。helper 返回后立即冻结 workbench 的 canonical path、dev、ino 与高精度 ctime；outbox 只持久化不含路径的十进制 dev/ino/ctime 身份并纳入 fingerprint。delivery 构造、路径解析、descriptor open 和读取前后都必须确认根仍是同一常规目录，不能用后续 `realpath` 结果重新确定可信根；同机 SQLite 重启可继续投递，跨文件系统迁移、root inode 或 ctime 变化均安全拒绝并要求重新排队。写入 outbox 前还必须重新确认 helper 结果相对冻结根仍是安全相对路径。路径链预检后必须以 `O_RDONLY | O_NOFOLLOW` 打开文件描述符，以初始 `fstat.size` 分配有界 Buffer，循环读取不超过该大小并额外探测一字节；读取前后用 `fstat` 和当前路径的 dev、ino、大小复验，整个读取使用同一 FileHandle。根目录、叶子或中间目录发生替换，即使随后换回，或读取期间文件增长，都一律拒绝且不得生成 Base64。任何可识别且 `code` 匹配 `E*` 的 filesystem error，无论是否带 `path`、`dest`、`syscall` 或 `errno`，都必须转换为稳定的 `SEND_FILE_SOURCE_*` 或 `SEND_FILE_ROOT_CHANGED` 错误；仅在 message 中泄露绝对路径的错误，以及 FileHandle 的 open、read、close 错误，也执行相同归一化。工具输出、请求日志和 outbox 错误不能包含 Agent workspace、workbench 或宿主绝对路径。outbox 投递还要复验文件内容摘要，避免排队期间文件被替换。

`conversation_asset` 是无历史兼容负担的新 durable kind，只接受 `schemaVersion: 2` 的 `runtime.conversation_asset` envelope，未版本化裸 payload 一律拒绝。envelope、payload、target、asset、root identity 与 `replyGate` 全部使用 exact-key decoder，未知、缺失或非法字段在 workbench 读取前安全拒绝。`replyGate` 必须存在，`generation` 为有界非空值，`scope` 与 `conversationId` 必须匹配冻结入站目标，两个 epoch 必须是非负安全整数；缺失或非法时禁止捕获当前 gate 作为回退。payload 只保留严格目标、不可变 origin identity 的 SHA-256 fingerprint、文件元数据、根身份、tool/log 标识和 gate，不复制正文、sender、quote、inline data、shared file、附件路径、视觉路径或其他入站快照。origin fingerprint 只规范化 OneBot transport、目标、messageId、selfId 与 time，允许入站事件落盘后 preparation 补充 sender、引用、媒体和附件而不改变授权身份。投递在任何 workbench 读取前重新读取 canonical outbox，并要求 `sessionId`、`originTurnId`、`kind`、`deliveryPartition`、完整 payload 和 envelope 字段均和当前记录一致；origin turn/event 必须属于同一 session，来源只允许 `incoming_reply` 或 `tool_completion`，并从该权威事件重算 fingerprint、管理员权限、目标和 gate。

冻结目标绑定显式 `onebot` transport、当前 Agent、显式账号、scope、user/group、message、self 与 conversation。envelope 的 `conversationId` 必须同时等于 session 和冻结目标，`correlationId` 必须等于 `logRunId`，顶层 `idempotencyKey` 和 payload `incomingFingerprint` 都只使用版本化 canonical identity 的 SHA-256，不嵌入原始正文或 URL。普通 outbox dedupe key 使用 `turn-outbox:<originEventId>:<ordinal>:<fingerprint>`，fingerprint 覆盖完整 payload、目标、根身份以及 `path`、`kind`、`name`、`byteLength`、`sha256`。operator 明确 `confirmedNotSent` 后允许重放 `delivery_unknown` 资产，重放行固定使用 `outbox-replay:<previousId>:<fingerprint>`；同一层重复调用在 replay 为 pending、sending 或 sent 时都返回同一行，不能产生第二副本。若 replay 自身再次进入 `delivery_unknown`，delivery 必须逐层加载上一 canonical row，每层都要求上一行仍为 `delivery_unknown`、没有 uncertain settle step，并交叉验证 session、origin turn、kind、partition、完整 payload 与可复算 replay fingerprint。lineage 记录 visited ID、最多回溯 8 层，最终必须唯一落到 `turn-outbox` root，再使用 root 的 event、ordinal、fingerprint 与 origin turn/event 完成全部 provenance 校验。循环、过深、伪造 key、任一中间行状态或内容变化均保持零文件读取、零远端 action。远端已经成功进入 settle 阶段后仍执行 canonical provenance 校验，但不重新执行会随配置变化的管理员、sender 和 gate send-phase 门禁，使本地 settle 可在管理员配置变化后完成且远端保持 exactly once。

自动模式根据真实文件类型把图片作为 OneBot `image` 消息段发送，其余内容作为文件发送；显式图片模式必须识别为图片。群文件与私聊文件分别使用 `upload_group_file` 和 `upload_private_file`，图片使用当前会话对应的消息 action。Core 只向 NapCat 发送 `base64://` 内联数据，不传递 Agent workspace、Core 容器或宿主绝对路径。OneBot adapter 必须再次强制执行 32 MiB 原始字节上限，先由 metadata `byteLength` 得到唯一编码长度与 padding，再线性校验字符和末尾 padding bits；校验过程不得通过 `Buffer.from(encoded, "base64")` 分配第二份大体积 decode Buffer。

`send_voice_message` 使用当前 Agent 的 Voice Profile 与在线 OpenAI Audio 兼容端点，把模型 Function Call 中的同源可读正文合成为 WAV，再作为独立 OneBot `record` 消息段发送。Profile 固定保存协议、Base URL、API Key 环境变量名、模型，以及 `zh`、`en`、`ja` 三个语言槽位的音色 ID；启用时默认语言必须已有音色 ID。运行时语言与音色只取 Profile，不受主会话语言限制，模型不能提交或改写这些值。每个语言仍可保存一份不超过 8 MiB 的参考音频与对应台词作为可选音色资料，但当前在线合成请求不读取或上传该文件。

在线客户端提交最多 300 字的正文、模型和音色，固定请求 WAV，响应最多读取 32 MiB；重定向、超时、非成功 HTTP、空响应、超限或非 WAV 内容均不得写入 outbox。合法结果按 SHA-256 写入当前 Agent `workbench/.voice-cache/voice-<sha256>.wav`，随后复用 `conversation_asset` schema v2、当前冻结目标、origin fingerprint、reply gate、文件身份与内容摘要门禁；OneBot adapter 只接收复验后的 `base64://` 字节并映射为 `record`，不接收在线凭据、Core 路径或供应商响应正文。

同源文字和语音各自拥有独立的准备与 durable outbox 记录。普通正文或 `assistant_text` 与合成并行启动，完成准备的一项立即自然入队；任一失败不撤销另一项。deferred tool 的 acknowledgement 与任务先原子持久化，语音生成完成后通过绑定该 turn 的 deferred emitter 追加；如果合成更早完成，只等待 handoff 已提交后追加。durable outbox 只保证各记录自身的幂等、重试和恢复，文字与语音没有人为先后屏障，远端观察顺序取决于各自完成和队列状态。

### 6.5 日常导演自拍

日常导演不建立独立图像通道。share callback 进入当前目标会话的正常 Agent loop 后调用既有 `selfie`，继续使用当前 Agent 的人格、自拍参考图库、聊天参考图预算、`selfie_prompt_rewrite.json`、内容寻址文件、图片历史与 OneBot Base64 外发。该 callback 单独使用原子图片回复模式：生图在当前 turn 内完成，图片成功前不提供或发送 `dispatch_message`、`assistant_text`、进度、占位、预告、等待提示、会话资产或语音；成功后的简短正文、自拍与其他内容必须进入同一条 durable reply，不能先发文字或拆成多条。普通图片请求仍使用异步图片任务。导演只提供当天已提交活动中的人物、现场、动作、表情、服装与光线意图，不能提供宿主路径、远端目标、参考图 URL 或跨 Agent 媒体。

每次主动分享必须包含当前角色本人并保持已配置外观锚点；同行角色只有在对应活动明确安排时才能出现，老师和现实用户不能被凭空加入画面。自拍未生成时 callback 以 `no_reply` 结束并保留内部失败日志，不能改用无自拍文本伪装完整分享；外发失败继续沿用 durable outbox 的错误与恢复语义，不能重复生成已经持久化的结果。
