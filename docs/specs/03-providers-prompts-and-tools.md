# Provider、提示词与工具

[返回当前系统规范索引](./index.md)

## 4. Provider、提示词与工具

### 4.1 Provider

Provider 类型包括 Codex 订阅、OpenAI 官方、Anthropic 官方、Gemini 官方，以及 OpenAI、Anthropic、Gemini 三种兼容协议。类型在创建时确定，创建后不可切换；官方地址由前后端共同固定，兼容地址可配置。Provider 支持远程拉取模型 ID 或自定义 ID，多模态能力可通过已知颜色图片的实际识别结果自动探测，也可手动指定；纯文本模型可配置独立的读图 Provider 与模型，运行时先生成图片描述再交给主模型。配置还包含图像模型、API key 环境变量、推理强度、温度和输出 token 上限。模型请求、响应、重试和工具结果写入请求日志，密钥和授权字段必须脱敏；Gemini API key 只能通过请求头发送，不能进入 URL。SDK 隐式重试必须关闭，发送请求与读取响应正文属于同一次显式传输尝试，正文断流按真实尝试记录并重试；由 `fetchTextWithTransportRetry` 管理的单次传输最多等待 60 秒，未指定调用级重试次数时仅在调用方仍有效的情况下重试一次，调用方取消不能触发重试；取消信号在写入请求日志前检查，429/5xx 退避优先遵守 `Retry-After` 或 `Retry-After-Ms`。

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

群聊回复的 Thread sidecar 是运行时受管内容，不暴露为可编辑提示词变量。默认模板将稳定的 `<group_context_contract>` 放入 system 消息；动态 `<thread_context>` 由运行时在渲染后插入 `messages_64` 与当前 user 消息之间。运行时只向旧占位提供空兼容值，避免模型派生 topic 进入自定义 system 内容，并替换、去重和重新定位自定义模板中的旧契约或旧 Thread 内容；清理范围不包含真实历史和当前 user，旧块旁的其他 system/developer 规则必须保留，旧 system 只有受管块时也必须保留该消息并写入当前契约。自定义模板即使使用 `conversation.messages`、重复展开历史，或把当前 user 放在历史消息之前，也要保持每份原始历史内部顺序，并恢复为全部历史在前、sidecar 和当前 user 在后的顺序。变量目录不再允许把该占位写入新模板，避免旧 Core 与新模板短暂并存时以缺少变量阻断群聊回复。Thread 分类使用独立最终提示词 `orchestrator.group-thread` 和公共文件 `group_thread_context.json`，不提供 Function Tool，要求严格 JSON Schema；分类器收到有界的历史 Thread 索引、本批完整有序消息和明确目标 ID。分类模型由当前 Agent 的 `bot.orchestrator.groupThreadModel` 选择，默认 `gpt-5.4-mini`，与主动回复编排器开关和 `userGroupchatOrchestratorModel` 相互独立；旧公共配置、旧 Agent manifest 及旧管理 API 响应缺少该字段时使用默认值，配置自检可按规则补齐该默认值。该调用记为 `orchestrator` 阶段，单批最多等待 5 秒；超时、Provider 错误或 schema 校验失败时保留原状态并继续主回复。

最终提示词渲染只递归解析模板和受信人格片段；本次运行时提供的消息数组、当前输入、记忆与 JSON payload 均作为不透明变量值注入，变量值中的 `@{...}` 或 `{{...}}` 不会再次展开。`orchestrator.group-thread` 的 Provider response schema 与宿主解析器使用一致的 Thread 数量、topic 长度、key 格式、assignment 数量和 related 唯一性边界，避免结构化输出通过 Provider 校验后又被宿主拒绝。

### 4.3 工具

Agent 工具目录固定包含 `assistant_text`、`no_reply`、`memory_recall`、`websearch`、`generate_img`、`selfie`、`workspace_bash`、`codex` 和 `system_config` 九项。时间读取、OneBot 消息外发和 Provider 检查属于系统或管理能力，不进入 Agent 工具目录。`no_reply` 与 `system_config` 是向后兼容的内置默认工具，旧提示词没有定义时仍会注入代码内置定义；`no_reply` 显式停用后从模型请求中移除。

`system_config` 只查询或修改当前 Agent。`get_settings` 返回自动回复、群聊编排、搜索、Bash 偏好、已知群聊和工具有效状态；`get_status` 返回运行时间、OneBot、人格、Provider、恢复门禁和安全裁剪后的探针结果。响应不得包含密钥、环境变量名、绝对路径、原始消息、Provider 地址或探针诊断正文。修改操作包括自动回复范围、主动群聊编排器、Tavily 搜索开关、管理员私聊 Bash backend 偏好，以及完整 conversation ID 对应的已知群聊回复/编排器开关。搜索实现当前只接受 `tavily`；未知群聊、裸 group ID、多余字段、缺失字段和不匹配参数均失败关闭。

配置修改只对无 prompt override 的当前管理员 QQ 私聊开放，并从下一轮生效；查询也可在同权限 QQ 私聊和管理 Web Chat 使用。Web Chat 没有 durable delivery，因此所有修改在暂存前返回 `SYSTEM_CONFIG_DURABLE_DELIVERY_REQUIRED`，查询保持可用。一次成功的 `system_config` 调用必须独占整个 Provider turn；同批或跨模型轮次混入正文、图片、deferred 或其他工具时，Provider 适配器拒绝整轮并清除 staged mutation。Bash backend 只保存 `native` 或 `docker` 偏好，实际可用性继续由 capability 探针决定；macOS Native 缺少 bubblewrap 或等价强隔离时 effective 状态为关闭，不能回退普通宿主 Bash，Docker backend 也不能通过 Docker socket 放宽隔离。

`bot.tools.overrides` 按工具名保存稀疏覆盖，每项允许可选的 `description`；除 `workspace_bash` 与 `codex` 外，其他工具还允许可选的 `enabled`。没有 `enabled` 覆盖时继承当前单聊或群聊回复提示词是否包含该 Function；显式启用可恢复代码内置定义，显式停用会从模型请求中移除该工具。`workspace_bash` 的启停只写入 `bot.bash.enabled`，`codex` 的启停只写入 `bot.tools.codex.enabled`，通用覆盖中的同名 `enabled` 会被移除。描述采用“配置覆盖、当前端点提示词、代码默认值”的优先级；删除描述覆盖后立即恢复当前端点提示词或代码默认描述。描述覆盖作用于所有 Provider 协议。

工具的配置启用状态与运行能力分开计算。`enabled` 表示配置和提示词选择，`available` 表示当前运行环境、会话权限及依赖能力，`effectiveEnabled` 仅在两者都为真时成立。管理 API 必须同时返回三种状态和不可用原因；平台强制关闭或当前会话无权限时，管理台不能把工具显示成可执行。被停用或不可用的工具既不能出现在 Provider 工具定义中，也不能通过模型返回的未声明 Function Call 绕过门禁执行或派发。

`dispatch_message` 负责 deferred tool 的首次受理消息，`assistant_text` 负责 inline 工具开始前的进度或补充问题，最终结果继续使用普通正文。两类消息写入 durable outbox 后立即调度发送，Provider inline 工具与 deferred worker 随后独立执行，不等待远端发送结果；发送失败继续由 outbox 重试，callback 与最终正文保持同一会话 FIFO。单轮工具调用上限可配置，默认 20，最大 100；工具启用状态与描述热更新，权限、超时和并发继续由对应运行配置控制。`workspace_bash` 仅供管理员使用，Docker 与 Linux Native 均固定通过 `/usr/bin/bwrap` 执行：宿主文件系统只读，Agent workspace 是唯一可写宿主绑定，沙箱自带的 `/dev` 仅提供非持久设备 I/O；子进程继承相同 mount/PID/IPC/UTS/cgroup 隔离且全部 capability 被丢弃。macOS 原生模式强制关闭该工具。命令与路径规则只作为附加拒绝层；bubblewrap 缺失、不可执行或内核 namespace probe 失败时必须拒绝命令，不能回退到普通 Bash。群聊默认不可用。

Codex CLI 是 Core 的固定版本运行依赖，Docker Core 必须在镜像内安装并通过版本 smoke，Native Core 必须在启动时验证可执行文件。Deferred worker 只从当前 workspace 的 `secrets/codex/auth.json` 复制授权到单次任务隔离目录；管理工具目录与真实回复 Provider 共用同一能力解析器，同时检查 CLI、授权与 Bash 隔离探针并在异常时安全关闭。CLI 缺失或版本不匹配时 Core 拒绝启动，授权缺失时 Core 保持可启动以允许管理员完成设备登录，但 Codex 工具不得被标记为可调用。
