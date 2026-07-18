# Provider、提示词与工具

[返回当前系统规范索引](./index.md)

## 4. Provider、提示词与工具

### 4.1 Provider

Provider 类型包括 Codex 订阅、OpenAI 官方、Anthropic 官方、Gemini 官方，以及 OpenAI、Anthropic、Gemini 三种兼容协议。类型在创建时确定，创建后不可切换；官方地址由前后端共同固定，兼容地址可配置。Provider 支持远程拉取模型 ID 或自定义 ID，多模态能力可通过已知颜色图片的实际识别结果自动探测，也可手动指定；纯文本模型可配置独立的读图 Provider 与模型，运行时先生成图片描述再交给主模型。配置还包含图像模型、API key 环境变量、推理强度、温度和输出 token 上限。每次模型传输的实际请求体与 Provider 返回 payload 都写入请求日志，使最终提示词、消息、工具定义和原始返回结构可以倒查；模型 payload 的单字符串最多保留 8 MiB，其他日志继续使用常规长字符串边界。密钥、授权字段和 URL key 必须递归脱敏，`read_file`、`write_file` 与 MCP 的参数、结果仍使用专用安全投影，不能因记录原始 payload 暴露文件正文、外部 MCP 文本、宿主路径或 token；Gemini API key 只能通过请求头发送，不能进入 URL。SDK 隐式重试必须关闭，发送请求与读取响应正文属于同一次显式传输尝试，正文断流按真实尝试记录并重试；由 `fetchTextWithTransportRetry` 管理的单次传输默认最多等待 60 秒，调用级内部预算可以显式覆盖，未指定调用级重试次数时仅在调用方仍有效的情况下重试一次，调用方取消不能触发重试；取消信号在写入请求日志前检查，429/5xx 退避优先遵守 `Retry-After` 或 `Retry-After-Ms`。

正常回复的每轮 Provider 请求使用公共 `normalReply.maxRetries`，值表示首次失败后的额外重试次数，默认 3、允许 0—10，因此默认最多执行 4 次相同请求。该设置热更新并由全部 Agent 共用，只作用于 `replyToIncoming` 的普通回复、群聊总结和异步结果回复，不改变编排器、记忆、生图、工具任务、outbox 或 Provider 健康检查的重试策略。显式请求必须复用同一请求体，只重试网络错误、正文读取错误、408、409、429 和 5xx；调用方取消或非重试状态立即停止。每次真实尝试分别写入请求日志，并记录当前尝试序号与最大尝试次数。

Provider 请求使用应用启动时安装的统一出站 dispatcher。显式代理和标准代理环境变量从 `workspace/secrets/runtime.env` 或进程环境读取；WSL 自动模式仅在没有显式代理时探测当前默认网关。代理选择不改变 OneBot 的 Compose 私有网络或同机宿主网关链路。

配置医生的 AI 诊断只在管理员显式请求时使用当前运行配置的默认 Provider，单次调用不提供任何 Function Tool，不执行多轮工具循环，并以严格 JSON Schema 请求结构化的 `add`/`replace` 建议。调用关闭 SDK 级重试，使用 `config_doctor` 阶段和提示词家族写入请求日志；服务端仍会重新解析、校验并按固定字段白名单过滤模型输出。AI 建议只补充本地规则尚未覆盖的允许字段，不能修改 `schemaVersion`、Provider、身份、路径、凭据或其他受保护配置，也不能直接写入配置文件。

OpenAI 官方 Responses 与 Codex Responses 请求必须携带稳定、不可逆且不包含明文身份的 `prompt_cache_key`。缓存键绑定 Provider、模型、行为、提示词家族、记忆类型、稳定 system/developer 前缀、完整工具定义和输出 schema；经验证支持稳定前缀缓存且实际存在静态前缀的模型按该前缀跨会话复用，其余请求继续包含完整会话 ID。同一工具循环的多轮请求复用同一个键。OpenAI 兼容协议不强制注入该字段，避免不支持扩展字段的服务拒绝请求。

GPT-5.6 及后续支持该协议的 OpenAI 官方 Responses 请求必须在最后一段前导静态 system/developer `input_text` 上设置显式 `prompt_cache_breakpoint`，并保留 Provider 默认的最新消息隐式断点。当前 Codex Responses 后端拒绝 `prompt_cache_breakpoint` 和 `prompt_cache_options`；GPT-5.6 及后续 Codex 请求不发送这些字段，将原有合并后的 system 文本映射为首个 developer input，不再同时发送 `instructions`，仅使用 `prompt_cache_key` 与精确前缀参与后端隐式缓存。原有非 system 输入的内容与顺序、工具定义和输出 schema 保持不变。旧模型、未知模型和兼容 Provider 不发送显式断点字段。静态前缀变化时缓存键自动变化；动态历史、召回记忆和当前输入不能进入稳定前缀哈希。

模型响应日志保留 Provider 返回的原始 usage，并在日志顶层写入统一的 `tokenUsage`。`tokenUsage` 字段为 `input`、`cachedInput`、`cacheRate`、`output` 和 `total`；日、小时聚合桶在此基础上增加 `requests`：

模型调用通过 `metadata.stage` 归入 `reply`、`orchestrator`、`memory` 或 `other`。记忆调用通过 `metadata.memoryKind` 区分 `working_long_term` 和 `user_profile`；工作记忆合并与长期记忆晋升由同一次 Provider 调用完成，因此统一展示为“工作与长期记忆”，不能虚构或重复计算独立的长期记忆调用。一次 Provider 请求只计入一个行为类别；没有 usage 的失败请求仍计入调用次数，每次实际传输重试分别计数。Deferred Codex 和自拍改写必须保留完整会话、行为阶段和尝试次数上下文。请求日志写入时同步更新当前 Agent 数据库的 `model_call_aggregates` 与 `model_call_model_aggregates`；前者保存该 Agent 全模型总量，后者按 `conversationId`、模型、行为和记忆类型聚合。单 Agent 统计只读对应业务库；全部 Agent 统计汇总各 Agent 聚合结果，不合并会话或记忆。群聊统计使用完整 `conversationId` 读取精确聚合行，不扫描历史日志。管理台模型调用区支持在全部模型和单个模型之间筛选，调用次数、Token 总量、行为分类和记忆分类必须使用同一模型聚合结果；缺少模型 ID 的历史调用统一显示为“未标注模型”。

- OpenAI Responses/Codex 使用 `input_tokens`、`input_tokens_details.cached_tokens`、`output_tokens` 和 `total_tokens`；Chat Completions 使用对应的 `prompt_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens` 和 `total_tokens`。输入总量已经包含缓存输入，不能重复相加。
- Deferred Codex CLI 进程实际启动后，无论完成或失败都以 `model.response`、`codex.tool.complete`、`codex-cli` 写入请求日志；usage 可用时使用 `input_tokens`、`cached_input_tokens` 和 `output_tokens`，其中缓存输入是输入总量的子集，总量由输入与输出相加。终态写入竞争、迟到返回和失败状态不能丢弃已经产生的 usage，同一任务尝试只能统计一次。
- Anthropic 输入总量是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，其中只有 `cache_read_input_tokens` 计入 `cachedInput`；缓存创建属于输入消耗，不属于缓存命中。输出使用 `output_tokens`，总量由输入与输出相加。
- Gemini 输入使用已经包含缓存内容的 `promptTokenCount`，并累加 `toolUsePromptTokenCount`；缓存输入使用 `cachedContentTokenCount`，输出是 `candidatesTokenCount + thoughtsTokenCount`，总量优先使用 `totalTokenCount`，小于归一化输入与输出之和时回退为后者。
- `cachedInput` 是 `input` 的子集，不额外计入 `total`。只有 Provider 明确返回缓存字段的记录才进入缓存率分母；单条记录或聚合桶的缓存率为这些记录的 `ΣcachedInput / Σinput` 并限制在 `0..1`。明确返回缓存字段但分母为 0 时返回 `0`；桶内全部记录都没有缓存字段时返回 `null`。缺失、负数和非有限数按 0 处理，任何 API 与界面值都不能出现 `NaN` 或 `Infinity`。

### 4.2 最终提示词

最终提示词使用 JSON 文档，支持：

- 多条 system、user、assistant 消息；
- 变量槽位；
- 所有提示词模板都可使用 `bot.name`、`user.name`、`runtime.current_time` 和 `utils.roll` 四项通用变量；`user.name` 仅在私聊回复中提供当前用户显示名，其他场景为空字符串；系统时间使用 ISO 8601；`utils.roll` 在每次模板请求时生成一个 1～100 的随机整数，同一次渲染内重复引用保持一致；
- 人格变量在所有最终提示词中可用；工作记忆、长期记忆和用户画像召回结果分别使用独立变量；
- function tools；
- JSON Schema response format；
- 管理台编辑、变量表、结构校验、冲突检测和运行时热更新；
- 运行时默认值与 Agent 工作区文件一致性测试。

每个 Agent 的人格正文独立保存在自身 workspace 的 `AGENTS.md`、`SOUL.md`、`PREFERENCE.md`、`DIALOGUE_STYLE_EXAMPLES.md`、`USER.md` 和 `RELATION.md`。默认 Plana 与管理台新建 Agent 都会以 write-if-missing 方式补齐这六个人格文件和 Agent 级最终提示词，已有定制文件不被覆盖。`DIALOGUE_STYLE_EXAMPLES.md` 通过 `persona.dialogue_style_examples` 注入对话回复和群聊总结，要求 Agent 严格遵从示例的语气、句式、节奏、用词和情绪强度。单聊回复与群聊回复分别使用 `conversation.private-reply` 和 `conversation.group-reply`，对应 `conversation_private_reply.json` 与 `conversation_group_reply.json`，运行时按会话范围选择，Prompt Cache 家族也分别计算。首次拆分时，现有 `conversation_reply.json` 内容分别复制到两个新文件，旧文件保留但不再作为回复入口。公共系统提示词默认从 `workspace/business/prompts/` 读取，所有 Agent 共用；`image.selfie-rewrite` 始终从当前 Agent workspace 的 `selfie_prompt_rewrite.json` 读取，不参与公共系统提示词继承或覆盖。Agent 的 `agent.json` 可通过 `prompts.overrideSystem` 开启系统提示词覆盖，开启时先把当前公共系统提示词复制到 `workspace/business/agents/<agentId>/system-prompts/`，后续仅由该 Agent 读取和编辑。关闭覆盖时保留私有副本并立即恢复公共系统提示词。人格文件、最终提示词、自拍参考图、工具覆盖和 Bot 行为均支持热更新；提示词和人格是小型、可审阅配置文件，不进入 SQLite。

`image.selfie-rewrite` 的 `selfie.payload.references.workspaceSelfies` 注入当前 Agent 自拍素材库中全部最多 9 项 `{id,note}`，不包含文件名、路径、图片字节或 Data URL。节点使用严格 JSON Schema 返回且只返回 `prompt` 与 `selectedSelfieReferenceIds`，后者必须按参考顺序选择 1—3 个清单内真实、唯一的 SHA-256 ID；空选、未知、重复、超量、额外字段或无效 JSON 均在读取图片和调用生图 Provider 前失败关闭。旧 `selfie_prompt_rewrite.json` 通过 `.selfie_prompt_rewrite.json.reference-selection-v1` 执行一次结构化选图契约和 response schema 迁移，保留管理员已有消息；marker 写入后，管理员对消息或 schema 的后续修改不再被运行时回填。

单个 Agent 的主动群聊职责应写入该 Agent 的人格文件，不修改公共群聊提示词。用户群聊编排器读取人格、偏好、对话示例和关系，并把角色职责作为是否主动回复的判断依据；群聊主回复继续读取同一组人格变量，保证触发条件与最终表达一致。只有需要改变编排器通用决策协议或该 Agent 的完整系统提示词结构时才启用系统提示词覆盖。

Tone 使用最终提示词 `conversation.tone-rewrite` 与公共文件 `tone_rewrite.json`，沿用 Prompt Catalog、公共系统提示词继承、Agent 系统提示词覆盖、热更新和变量渲染机制。模板可使用 `bot.name`、`user.name`、`runtime.current_time`、`utils.roll`、六个人格变量及 `tone.input`；`tone.input` 作为不透明值注入，其中的 `@{...}` 与 `{{...}}` 不会再次展开。节点不接收会话历史、工具定义、工具结果、媒体 payload 或任务上下文，只负责按照人格、对话示例、说话习惯和自然口语清理即将外发的表达，同时保持原文事实、结论、承诺、问题、数字、链接、代码、命令、文件名、专有名词与 @ 对象。宿主在渲染后重建请求，只保留 messages、空 tools 和 text response format，并显式停用全部 Agent 工具；管理员即使在提示词 JSON 中加入 Function Tool、结构化输出或其他请求字段，也不能让 tone 进入工具循环、MCP、Skill、审批或其他副作用路径。

`bot.tone` 随 Agent 独立保存 `enabled`、`providerId`、`model`、`reasoningEffort`、`temperature`、`maxOutputTokens` 与 `maxRetries`；空 `providerId` 跟随当前默认 Provider，其余字段不继承普通回复参数。默认关闭，默认模型 `gpt-5.4-mini`、推理强度 `low`、Temperature `0.7`、输出上限 2,400 Token、失败重试 2 次；Temperature 允许 0—2，输出上限允许 1—1,000,000，重试允许 0—10。启用后的单次节点总预算为 60 秒并继承当前会话取消信号，日志使用 `stage=tone` 与 `promptFamily=conversation.tone-rewrite`；现有统计将该阶段归入“其他”。各 Provider 继续按自身协议发送支持的生成参数；当前 Codex Responses 传输使用独立模型与推理强度，但不发送 Temperature 和最大输出 Token 字段。

单聊与群聊回复注册动态变量 `conversation.emoji.keys` 和 `conversation.emoji.syntax`。前者只列出当前 Agent 通过 SQLite 字段、内容寻址文件名、普通非符号链接文件与记录字节数候选检查的 key，构造提示词时不读取或哈希整座图库；后者固定说明 `[/表情key]` 语法、精确选择与单条最多 4 个的限制。实际命中的 key 在写入 outbox 前执行异步完整性复验。默认模板在当前输入规则中显式引用两项。升级时，既有回复模板以 `.emoji-v2` 标记执行一次持久迁移：只有 system、developer 或 user 的字符串 message content 中的变量引用有效，response schema、额外字段和 assistant 消息中的伪装都不计数，缺少任一变量时只把缺项补入受控 developer block。既有 tone 模板以 `.emoji-marker-v2` 标记补入 system 消息中的标记原样保留规则，user 消息或 response schema 中的同文规则不算完成；v2 迁移会越过已有错误 v1 marker，覆盖半迁移、同 basename 子目录和公共/Agent overrideSystem。新 marker 落盘后，管理员主动移动、删除或改写变量和规则不会在后续重启时被回填。

群聊回复把 Thread sidecar 注册为正式动态变量 `conversation.group.thread_context`，变量目录可见且管理员可在群聊回复模板中编辑其角色、包装和位置。默认模板将稳定的 `<group_context_contract>` 放入 system 消息，并在 `messages_64` 之后、当前 user 输入之前以 developer 消息引用 `<thread_context>@{conversation.group.thread_context}</thread_context>`。运行时只提供经过容量限制与标签安全转义的 Thread JSON 字符串，按管理员模板正常渲染，不再插入、删除、去重或重排 Thread 块、系统契约、历史消息和当前输入；当前输入的临时标记仅用于把图片与附件关联到真实 user 消息，发送 Provider 前清除且不改变消息顺序。升级时，尚未引用变量的既有默认或自定义群聊模板执行一次持久迁移，在原有当前输入之前补入可编辑 developer 消息并保留其余消息顺序；迁移标记完成后，管理员主动删除或移动变量不会在后续重启时被恢复。Thread 分类使用独立最终提示词 `orchestrator.group-thread` 和公共文件 `group_thread_context.json`，不提供 Function Tool，要求严格 JSON Schema；分类器收到有界的历史 Thread 索引、本批完整有序消息和明确目标 ID。分类模型由当前 Agent 的 `bot.orchestrator.groupThreadModel` 选择，默认 `gpt-5.4-mini`，与主动回复编排器开关和 `userGroupchatOrchestratorModel` 相互独立；旧公共配置、旧 Agent manifest 及旧管理 API 响应缺少该字段时使用默认值，配置自检可按规则补齐该默认值。该调用记为 `orchestrator` 阶段，单批最多等待 5 秒；超时、Provider 错误或 schema 校验失败时保留原状态并继续主回复。

群聊回复还注册动态变量 `conversation.group.orchestrator_result`。主动群聊编排器触发时，该变量是经过标签安全转义的单行 JSON 字符串，字段固定为 `should_reply=true`、`reason` 和 `reply_to_message_id`；直接回复、命令、群聊总结及其他非编排器触发路径固定为空字符串。默认群聊模板在 Thread developer 消息之后引用该变量，管理员可以把变量移动到任意角色和位置或重复引用，运行时只按模板渲染，不根据本轮 route 插入、删除、去重或重排消息。升级时，既有群聊模板只执行一次变量引用迁移，既有用户群聊编排器模板只执行一次结构化输出 schema 迁移；迁移标记完成后不再回填管理员后续修改。编排结果作为不透明变量值注入，异步工具回调继续复用派发时冻结的同一结果。

最终提示词渲染只递归解析模板和受信人格片段；本次运行时提供的消息数组、当前输入、记忆与 JSON payload 均作为不透明变量值注入，变量值中的 `@{...}` 或 `{{...}}` 不会再次展开。`orchestrator.group-thread` 的 Provider response schema 与宿主解析器使用一致的 Thread 数量、topic 长度、key 格式、assignment 数量和 related 唯一性边界，避免结构化输出通过 Provider 校验后又被宿主拒绝。

### 4.3 工具

`system_config`、`send_file`、`read_file`、`write_file` 与 `workspace_bash` 统一视为受限工具。OpenAI Responses、Codex Responses、Chat Completions、Anthropic Messages 和 Gemini generateContent 在每份含 Function Call 的模型响应上先执行同一套 response preflight；检查必须早于 deferred/`no_reply` 接受、普通或 `assistant_text` 正文 callback，以及任何文件、配置、Bash、queue 或 outbox 副作用。同一响应含非空普通 assistant 文本和任一受限工具，或受限工具与任意其他 inline、deferred、`no_reply`、`assistant_text` Function Call 混用时，整份响应按全部 `call_id` 返回稳定拒绝结果且零副作用；已 staged 的 `system_config` mutation 必须先 discard。普通非受限工具与同响应正文继续沿用原行为。

Agent 工具目录固定包含 `assistant_text`、`no_reply`、`memory_recall`、`websearch`、`generate_img`、`selfie`、`read_file`、`write_file`、`send_file`、`send_voice_message`、`workspace_bash`、`codex`、`activate_skill`、`read_skill_resource`、`run_skill_script` 和 `system_config` 十六项。时间读取、任意目标 OneBot 消息外发和 Provider 检查属于系统或管理能力，不进入 Agent 工具目录。`no_reply`、`read_file`、`write_file`、`send_file` 与 `system_config` 是向后兼容的内置默认工具，旧非空提示词没有定义时，只要对应运行能力可用，仍会注入代码内置定义；显式停用后从模型请求中移除。文件工具始终使用代码内置的严格参数 schema，旧提示词不能恢复宿主绝对路径、账号或会话目标参数，也不能放宽字段集合。

`system_config` 只查询或修改当前 Agent。`get_settings` 返回自动回复、群聊编排、搜索、Bash 偏好、最多 100 个已知群聊的摘要和工具有效状态；`get_status` 返回运行时间、OneBot、人格、Provider、恢复门禁和安全裁剪后的探针结果。`list_groups` 按完整 conversation ID 的二进制字典序分页查询当前 Agent 的全部已知 `user_group`/`bot_group`，`groupCursor` 是上一页最后一个完整 conversation ID，`groupLimit` 允许 1—100、`null` 默认 50，响应返回 `total`、`items`、`nextCursor` 和 `hasMore`；格式合法但当前不存在的游标继续返回字典序更大的记录，并发插入不提供快照分页保证。群聊项只包含 conversation ID、账号、群号、标题、范围、回复开关、编排器开关和最后活动时间。响应不得包含密钥、环境变量名、绝对路径、原始消息、Provider 地址或探针诊断正文。修改操作包括自动回复范围、主动群聊编排器、Tavily 搜索开关、管理员私聊 Bash backend 偏好，以及任意真实完整 conversation ID 对应的已知群聊回复/编排器开关；`set_group_reply` 不受查询页大小限制。搜索实现当前只接受 `tavily`；未知群聊、裸 group ID、多余字段、缺失字段和不匹配参数均失败关闭。

配置修改只对无 prompt override 的当前管理员 QQ 私聊开放，并从下一轮生效；查询也可在同权限 QQ 私聊和管理 Web Chat 使用。Web Chat 没有 durable delivery，因此所有修改在暂存前返回 `SYSTEM_CONFIG_DURABLE_DELIVERY_REQUIRED`，查询保持可用；QQ 宿主缺少真实 held outbox 或 reply-gate resolver 时在 append 阶段失败关闭且不提交。一次成功的 `system_config` 调用必须独占整个 Provider turn；同批或跨模型轮次混入正文、图片、deferred 或其他工具时，Provider 适配器拒绝整轮并清除 staged mutation。配置只在确认进入 schema v5 held 行后提交，commit 成功后才写入 released provenance；commit 失败或遗留 held 恢复只发送固定中性通知。Bash backend 只保存 `native` 或 `docker` 偏好，实际可用性继续由 capability 探针决定；macOS Native 缺少 bubblewrap 或等价强隔离时 effective 状态为关闭，不能回退普通宿主 Bash，Docker backend 也不能通过 Docker socket 放宽隔离。

`bot.tools.overrides` 按工具名保存稀疏覆盖，每项允许可选的 `description`；除 `workspace_bash` 与 `codex` 外，其他工具还允许可选的 `enabled`。没有 `enabled` 覆盖时继承当前单聊或群聊回复提示词是否包含该 Function；显式启用可恢复代码内置定义，显式停用会从模型请求中移除该工具。`workspace_bash` 的启停只写入 `bot.bash.enabled`，`codex` 的启停只写入 `bot.tools.codex.enabled`，通用覆盖中的同名 `enabled` 会被移除。描述采用“配置覆盖、当前端点提示词、代码默认值”的优先级；删除描述覆盖后立即恢复当前端点提示词或代码默认描述。描述覆盖作用于所有 Provider 协议。

Agent Skill 使用渐进披露。普通回复只注入当前 Agent 已启用、内容摘要与批准摘要一致的 Skill 名称、说明和虚拟路径；目录总预算为模型上下文的 2%，无法确定窗口时为 8,000 字符，超限时先裁剪说明，再省略条目并给出稳定提示。`allow_implicit_invocation=false` 的 Skill 不进入隐式目录，但仍可由管理员显式选择。`activate_skill` 与 `read_skill_resource` 的 `available` 只表示对应运行端口已经接线，不以当前 Agent 的 Skill 数量判断；空目录时 API 仍返回 `available=true`，但 `effectiveEnabled=false`，Provider 也不注册带空枚举的工具定义。管理台不展示健康能力状态，只在 `available=false` 且 `unavailabilityKind=runtime` 时标记“运行环境异常”并显示具体原因。非默认组合根没有显式声明 Skill 端口时必须将能力报告为不可用。存在可用 Skill 时才向 Provider 注册动态 `activate_skill` 与 `read_skill_resource`，参数枚举只包含当前 Agent 的有效 Skill；激活返回受保护的完整 `SKILL.md`、`/skills/<id>` 虚拟目录和有界资源清单，不主动读取引用资源，同一会话按 Skill ID 与内容摘要去重，后续提示词压缩继续保留已激活说明。Skill 目录、正文和资源均视为外部输入；当前组合根不注册 `run_skill_script`，模型伪造调用必须在读取、投影和沙箱前返回 unavailable。

Skill 脚本安装审查、摘要绑定投影、只读 workbench、只读 `/skills`、临时 `/tmp`、无网络强隔离和有界输出清理属于未接线的安全基础模块，不能作为脚本执行能力已经交付的证据。当前执行模型无法证明目标脚本不会通过解释器、模块加载、`source`、直接可执行文件或其他进程入口运行第二段未审计代码，因此所有平台默认关闭脚本 capability。未来启用必须同时具备固定且可证明的单段执行模型、覆盖完整实际执行字节的独立审计与一次性审批，并补齐 `/skills`、`/workbench` 和模块加载二段执行的零副作用负例；任意 64 位十六进制 fingerprint 不能单独构成授权。

Skill 安装、替换和跨 Agent 复制后固定为停用、未审批和未审查。启用前必须由独立审核 runner 读取当前摘要绑定的完整普通文件清单、`SKILL.md`、references、配置及其他有界 UTF-8 文本；已知二进制只进入 manifest，单脚本上限 256 KiB、全部脚本上限 1 MiB，单文本上限 512 KiB、全部文本上限 2 MiB。审核记录脚本、MCP 依赖、文件访问、外部来源 origin、内容摘要、来源和 review version，拒绝运行时下载、脚本联网、硬编码凭据、私钥、恶意外发链接及 MCP 与文件访问的危险组合。审核通过时以 Skill index revision、内容摘要和完整 manifest 做 CAS，并在同一次原子索引写入中同时记录 risk review 与管理员 approval；启用必须同时匹配这两份当前摘要。停用保留审批，内容替换清除两份审批，复制失败回滚只允许恢复同一内容摘要的既有双审批状态。

跨 Agent 复制的 MCP 描述符在预览和 apply 中使用同一目标安全投影：全部先停用；stdio 只保留非秘密 `envKeys` 名称，Bearer/OAuth credential reference 替换为不可解析的待授权标记；存在秘密依赖的描述符记录 `reauthorization_required`。目标 Agent 的 configured/missing 状态继续按保留的 key 名显示；管理员必须重新确认完整 stdio 命令并替换目标描述符，且全部 key 已在目标 secret store 配置后才能启用。普通命令、参数、URL 和工具策略可以复制，源 Agent 的环境变量值、Bearer reference、OAuth handle 和 token 均不能进入目标索引、复制结果或事务日志。

MCP V1 使用 `@modelcontextprotocol/sdk@1.29.0` 与 2025-06-18 协议。每个 Agent 的每个 server 独占 client、session、目录快照、取消信号和秘密投影；initialize 强制单一协议版本与 strict capability enforcement，未协商的 tools、resources、prompts、subscriptions 或 listChanged 不得调用。tools、resources、resource templates 和 prompts 均执行有界完整分页，按名称或 URI 去重后原子替换快照；任一页失败保留旧快照并标记 degraded，刷新中的 listChanged 触发下一轮完整刷新，通知风暴超过上限后失败关闭。prompts 只能通过管理员显式 API 选择，不能由模型自动执行；resource URI 继续由 server ACL 控制，`file:` 只允许虚拟 `file:///workbench`，不映射宿主路径。资源订阅仅在 server 宣告能力且 URI 已存在于当前快照时开放；只处理当前 client 已成功订阅 URI 的 `resources/updated`，通知触发安全刷新，退订、禁用、Agent 关闭或进程关闭时清空订阅和 client。

MCP tool definition 只来自当前 Agent 的 ready 快照，`enabledTools` 是优先 allowlist，显式空数组表示全部关闭，`disabledTools` 随后拒绝；写入、删除和网络能力默认要求逐次批准，server annotations、instructions、描述、结果和错误均不可信。MCP Function Call 必须独占整份 Provider 响应，原始 sibling assistant text 或与任意其他工具混用时在 callback 前整批拒绝。Provider preflight 还必须从可信 alias 解析 server ID 与 transport：stdio 归入本地数据边界，Streamable HTTP 归入外发网络边界，本地与外发工具在同一 provider turn 内双向冲突；同一 turn 最多使用一个 MCP server，避免跨 server 搬运数据。请求日志只保存参数键和 MCP 结果的有界结构摘要，包括状态、错误布尔值、内容类型、数量、字节数和截断状态；不复制 server 文本、错误、prompt、图片、token、Unix/Windows 路径、getter、Proxy 或 `toJSON` 结果。

成功 initialize 后的 server instructions 只作为当前 Agent、当前 ready 且本轮实际可用 server 的选择提示注入 system context。每项继续保留 `[External MCP input]` 标记与 512 字符上限，整段使用受保护边界并明确不能授予权限、批准调用、改变策略或要求使用工具；单轮最多 16 个 server、总计 4 KiB。其他 Agent、degraded/disabled server、未进入本轮工具定义的 server instructions 不得进入提示词，超限条目按稳定顺序省略。

`send_file` 的模型定义始终由代码侧 canonical strict schema 覆盖：对象只允许且必须包含 `path`、`kind`、`name` 三个键，`name` 可以为 `null`，并固定 `additionalProperties: false`。陈旧或恶意提示词不能改变该参数边界，账号、QQ 号、群号和其他额外字段一律拒绝。`send_file` 必须独占一次模型 response；与 `assistant_text`、系统配置、Bash、deferred tool、其他 Function Call 或原始 assistant 文本同时出现时，OpenAI Responses、Codex Responses、Chat Completions、Anthropic 与 Gemini/兼容协议都必须在任何 intermediate text callback、文件解析、queue 和 outbox 前拒绝整份 response。

工具的配置启用状态与运行能力分开计算。`enabled` 表示配置和提示词选择，`available` 表示当前运行环境、会话权限及依赖能力，`effectiveEnabled` 还要求当前工具具备必要的调用目标。管理 API 必须同时返回三种状态和不可用原因；`available=false` 时还必须用 `unavailabilityKind=runtime|session` 区分运行故障与会话适用范围，并可返回安全裁剪后的 `accessLabel`、`accessDescription`。管理台以中性样式标注适用会话，只有审计、workbench 或隔离能力异常等 `runtime` 状态使用错误语义；平台强制关闭或当前会话无权限时均不能把工具显示成可执行。被停用或不可用的工具既不能出现在 Provider 工具定义中，也不能通过模型返回的未声明 Function Call 绕过门禁执行或派发。

Agent 设置中的工具启停是所属 Agent 的总开关。每个 QQ 私聊、群聊和 `web:admin` Web Chat 会话可以持久保存独立的 `disabledTools` 稀疏列表；字段缺失或为空时全部工具继续跟随 Agent 总开关。最终可调用状态依次要求 Agent 总开关启用、会话未停用、当前运行能力可用，因此会话只能收窄权限，不能恢复 Agent 已停用的工具，也不能绕过管理员身份、真实入站、Bash 隔离、文件身份或异步投递门禁。会话限制同时作用于 Provider 工具定义、执行模式判定和未声明 Function Call 校验。

`read_file` 与 `write_file` V1 仅向当前 Agent 的真实 OneBot 管理员私聊开放；群聊、Web Chat、普通用户、缺少账号或消息身份、Agent 不匹配以及任何 `promptOverride` 请求都不获得运行端口。工具只接受当前 Agent `workbench/` 内的 POSIX 相对路径，分别读取有界 UTF-8 文本或以 0600 临时文件原子发布完整 UTF-8 文本；不接受账号、会话、宿主路径、建目录或追加写入参数。同一模型 Function Call 批次包含文件工具与任意其他工具时必须整批零副作用拒绝；文件工具前后出现已接受的助手消息、inline 或 deferred 工具时也必须拒绝。各 Provider 协议在发送同响应的普通 assistant 文本前还必须执行相同的整轮独占门禁。

`/api/tools` 与 Provider 使用同一实时能力来源计算 `send_file.available`：OneBot adapter 必须提供会话资源外发能力，且当前 Agent 至少有一个归属账号在线；resolver 缺失或异常时安全返回不可用。配置启用状态与实时能力状态分别返回，不能把 `available` 固定为真。

`dispatch_message` 负责 deferred tool 的首次受理消息，`assistant_text` 负责 inline 工具开始前的进度或补充问题，最终结果继续使用普通正文。两类消息写入 durable outbox 后立即调度发送，Provider inline 工具与 deferred worker 随后独立执行，不等待远端发送结果；发送失败继续由 outbox 重试，callback 与最终正文保持同一会话 FIFO。单轮工具调用上限可配置，默认 20，最大 100；工具启用状态与描述热更新，权限、超时和并发继续由对应运行配置控制。

`workspace_bash` 默认只向无 `promptOverride` 的真实 OneBot 管理员私聊开放。入站必须同时绑定当前 Agent、非空账号、有效消息与 Bot 身份、管理员 user/sender；普通私聊、Web Chat、缺失或不匹配身份和默认群聊均不获得工具定义。管理员私聊使用当前 Agent 的 `adminPrivateBackend`；未来显式启用群聊还必须保持 `adminOnly=true`、`allowGroup=true`，并固定使用 Docker `restricted` 模式。API 工具目录只接收实时 capability 标记，返回管理员 QQ 私聊或已启用的管理员群聊范围、当前私聊 backend，以及安全原因码 `BASH_AUDIT_UNAVAILABLE`、`BASH_WORKBENCH_UNAVAILABLE`、`BASH_NATIVE_ISOLATION_UNAVAILABLE` 或 `BASH_DOCKER_ISOLATION_UNAVAILABLE`；不得取得 Provider 的 audit runner、审批上下文、宿主路径、沙箱诊断正文或可执行 Bash options。模型伪造未声明调用或不完整 options 时在沙箱启动前失败关闭。

Bash capability 必须把当前 Agent workbench、所选 backend、独立审计可用性和强隔离探针作为一个原子结果；缺少任一依赖时 `available=false` 并返回与失败门禁对应的安全原因码，直接调用安全层时返回 `BASH_AUDIT_UNAVAILABLE`。状态只探测已配置会话实际使用的后端：管理员私聊探测 `adminPrivateBackend`，管理员群聊启用时另探测固定 Docker 受限路径；未配置的备用后端不能为改善展示而自动启动。运行时每次配置替换都递增单调 `configEpoch`，单一 resolver 在同一不可变配置快照中冻结 epoch、真实入站身份、backend、workbench、access mode、strict mode、审批上下文和独立 audit runner，再完成审计可用性与强隔离探针；任一 await 后 epoch 改变只允许一次有界重探，仍变化则失败关闭。Provider 直接接收完整不可变 handle，并把同一 `isCurrent` 闭包传入 Bash runner；入口、workbench resolve/capture、审计前后、restricted/outside path prepare/verify、审批 issue/consume、隔离 probe 前后、invocation 构造及最终 spawn 前都必须复验，getter 抛错同样按 stale 处理。旧 handle 返回 `BASH_CONFIGURATION_STALE`，不得签发或消费审批、启动隔离探针或执行命令；若配置只在隔离探针进行中变化，探针结束后仍必须保持零 spawn。审计使用当前默认启用 Provider 的独立实例与 `bot.bash.auditModel`，请求只含审计 system/user 消息、`tools=[]` 和 strict JSON schema，不复用当前会话上下文；调用方 abort signal 同时约束审计与执行。审批票据绑定 Agent、账号、transport、完整会话、用户、可选群号和命令摘要，只能一次性消费。Linux/WSL Native 与 Docker Core 使用 capability 探针通过的 bubblewrap 强隔离；Host Docker 使用无网络、无 Docker socket、固定 entrypoint/空环境和资源上限的独立容器。macOS Native 缺少等价强隔离时必须关闭，任何路径都不能回退到普通宿主 Bash。

`send_file` 是当前会话定向的 inline 工具，只接收当前 Agent `workbench/` 内的相对路径、发送模式和可选显示名，不接受账号、QQ 号或群号。只有当前入站用户是已配置管理员，且当前 transport 同时提供 OneBot 文件能力与 durable outbox callback 时，Provider 才能声明该工具；真实 OneBot 入站允许既有 parser 产生的 `transport` 缺省值，显式 `web` 必须拒绝。普通私聊用户、普通群成员和伪造 Function Call 均不可用，运行时 queue 还要在任何文件解析前再次执行同一管理员门禁。Provider 执行时固定文件类型、名称、大小、SHA-256 和 workbench 根 dev/ino/ctime 身份；durable outbox 只写入严格的当前目标、不可变 origin identity 的 SHA-256 fingerprint、文件元数据、根身份和 reply gate，不复制正文、sender、引用、媒体、附件、Base64 或宿主路径。实际发送前重新通过统一 workbench 路径解析器解析同一相对路径，以 `O_NOFOLLOW` 文件描述符打开，以排队时文件大小分配有界 Buffer 并在读取前后复验普通文件、单硬链接、根身份、dev、ino、大小和摘要，再转换为 `base64://` 交给 OneBot。群聊、单聊和显式 `accountId` 全部来自触发工具调用的入站消息，缺省账号冻结为 `primary`，模型不能改投其他目标。`send_voice_message` 保留独立 schema 与 OneBot 底层 `record` 能力，但当前运行能力固定不可用，不进入 Provider 工具定义；伪造 Function Call、内部 voice queue 或 durable voice outbox 均须明确拒绝。

Codex CLI 是 Core 的固定版本运行依赖，Docker Core 必须在镜像内安装并通过版本 smoke，Native Core 必须在启动时验证可执行文件。Deferred worker 只从当前 workspace 的 `secrets/codex/auth.json` 复制授权到单次任务隔离目录；管理工具目录与真实回复 Provider 共用同一能力解析器，同时检查 CLI、授权与 Bash 隔离探针并在异常时安全关闭。CLI 缺失或版本不匹配时 Core 拒绝启动，授权缺失时 Core 保持可启动以允许管理员完成设备登录，但 Codex 工具不得被标记为可调用。
