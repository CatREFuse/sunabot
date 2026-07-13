# sunabot 当前系统规范

版本：2026-07-13
状态：当前实现的唯一规范
适用范围：sunabot 后端、Plana Agent、OneBot 接入、管理台、持久化、测试和部署

## 1. 产品范围

sunabot 是面向个人自托管场景的 QQ Agent 服务。系统通过 OneBot v11 反向 WebSocket 接入 NapCat，以普拉娜人格处理私聊和用户群聊，支持上下文回复、群聊编排、长期记忆、用户画像、文件读取、联网搜索、图像生成、自拍、Codex 异步任务、本地 Web Chat 和管理台。

当前运行目标是单实例、单管理员、单默认 Agent。多 Agent、多租户、完整 OneBot v12 和公网多用户管理台不属于当前版本。

## 2. 运行结构

```text
宿主机 ./sunabot.sh
├── Sunabot Core（Native 或 Docker）
│   ├── 127.0.0.1:8787 管理 API 与 Vue 管理台
│   ├── :8788 OneBot v11 反向 WebSocket（强制 token）
│   ├── SunaRuntime / SessionCoordinator / provider / tools
│   └── sunabot.sqlite / session-queue.sqlite
└── NapCat Docker
    ├── QQ 与 NapCat 登录态
    ├── 127.0.0.1:6099 NapCat WebUI
    └── OneBot 事件、action 与 base64 媒体
```

NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器。Sunabot Core 可以在宿主环境 Native 运行，也可以作为独立 Core 容器运行；根目录 `./sunabot.sh` 统一负责初始化、配置、启动顺序、健康检查、停止和日志。`SUNABOT_CORE_MODE=auto` 在 macOS 选择 Native Core，在 WSL2/Linux 选择 Docker Core，也可显式选择 `native` 或 `docker`。

管理 API 只发布到宿主回环 `127.0.0.1:8787`。OneBot 使用专用 `8788` 端口并强制校验 access token：Docker Core 模式通过 Compose 私有网络和 `core` 服务名连接；Native Core 模式由启动器配置容器可达的宿主网关。OneBot 不直接发布到局域网或公网。NapCat WebUI 只发布到宿主回环 `127.0.0.1:6099`。

Core 与 NapCat 是独立生命周期和文件系统边界。跨组件出站媒体默认使用 OneBot `base64://`，不能传递或依赖宿主、Core 容器、NapCat 容器之间的共享绝对路径。业务配置、Agent、SQLite、图片历史和原始生成文件继续使用同一 workspace 结构；NapCat 配置、QQ 登录态和运行状态单独位于 `workspace/runtime/napcat/`，只挂载给 NapCat 容器。平台差异只存在于组合根、运行适配器和部署层，业务与持久化格式保持一致。

Provider、Codex CLI 与联网工具的出站 HTTP(S) 可独立使用代理。API 在载入 composition root 前由 `packages/platform/proxy.mjs` 解析并安装 Undici dispatcher，优先级为 `SUNABOT_PROXY_URL`、标准 `HTTP_PROXY`/`HTTPS_PROXY`、WSL 默认网关与配置端口探测。`SUNABOT_PROXY_MODE` 支持 `auto`、`env`、`wsl-host` 和 `off`；网关只从当前默认路由动态发现，不写死地址。Native Core 与 Docker Core 使用 `deploy/runtime-contract.json` 中的同一代理契约。`NO_PROXY` 必须包含回环地址、Compose 服务名和启动器选择的宿主网关，代理 URL 与凭据不得进入日志、状态接口或 Git。

后端固定使用 Node.js 24.18.0、TypeScript 和 Fastify，管理台由 Vue 3、Vue Router 和 Vite 构建。`.node-version`、`.nvmrc`、package/lock、CI、Native release manifest、runtime contract、component lock 和 Docker 必须保持同一 Node 版本；`npm run runtime:contract` 静态拒绝入口漂移，但不比较开发机当前进程。Native Core 与 Docker Core 的构建、安装和启动都会执行实际版本检查。生产服务由 `dist/apps/api/main.js` 启动；管理 API、Web 静态资源与 OneBot WebSocket 使用彼此独立的监听边界。

## 3. 消息接入与回复

### 3.1 OneBot 接入

- 仅在专用 OneBot listener 的配置路径接收 OneBot v11 反向 WebSocket。
- NapCat 只能通过同机 Compose 私有网络或容器到宿主网关连接，不支持公开或跨主机 OneBot 入口。
- 所有连接都使用 `workspace/secrets/runtime.env` 中的 access token 校验；缺失 token 时 Core 与 NapCat 都拒绝启动。
- 支持私聊、用户群聊和 bot 群聊范围识别。
- 支持文本、CQ 码、图片、回复引用、@、QQ 文件和 OneBot action 回包。
- 好友名、备注、群名和群名片用于显示层补全，不改变 QQ 号这一身份主键。
- 私聊、用户群聊、bot 群聊和命令接受具有合法 QQ 号的发送者；管理员身份仍由 `bot.adminQq` 精确识别，并用于管理员专属工具和称呼。非法发送者在进入会话记录和命令匹配前静默丢弃，恢复任务与 outbox 外发前必须再次校验发送者格式和当前回复门控。

### 3.2 路由

每条消息按以下优先级进入运行时：

1. 显式命令，例如群聊总结。
2. 私聊或明确 @ 的直接回复。
3. 用户群聊的唤醒词与编排器判断。
4. bot 群聊仅记录上下文，不主动编排。

全局开关、群类型开关、会话开关、连接状态和编排器 epoch 共同构成回复门控。门控关闭后，旧的在途编排结果不能继续外发。

### 3.3 会话执行

- 每个会话拥有有序事件流，事件、turn、异步工具任务和 outbox 使用 SQLite 持久化。
- 同一会话按序处理；不同会话允许受控并发。
- 外发使用 outbox，支持租约、有限重试、断线恢复和幂等键。
- Codex 与图像生成长任务先返回确认消息，任务完成后通过持久化事件恢复原会话；任务提交不能等待生成完成。所有 deferred tool 必须单独调用并携带非空 `dispatch_message`，由模型使用当前人格生成“已收到并开始处理”的短消息；该字段与任务在同一事务中落库为 acknowledgement，进入 worker 前从业务参数中删除。缺失、空白或超过 200 字时不得派发，也不得降级为同步执行。
- `assistant_text` 允许 Agent 在工具循环中发送中间消息。群聊只引用第一条中间消息，最终正文仍引用原始消息，后续中间消息不引用。
- 新写入的 Bot 消息持久化 `messageOrigin` 与按首次调用顺序去重的 `toolNames`。来源区分普通正文 `text`、显式 `assistant_text`、异步受理 `async_tool_dispatch` 和异步结果 `async_tool_callback`；工具清单只记录本轮实际接受的 Function Call，不能使用 Provider 请求中的可用工具定义反推。旧消息缺少来源时保持未知，不按正文、时间或日志邻近猜测。
- 会话最多保留 2,000 条消息，最多保留最近 80 个会话。

## 4. Provider、提示词与工具

### 4.1 Provider

Provider 类型包括 Codex 订阅、OpenAI 官方、Anthropic 官方、Gemini 官方，以及 OpenAI、Anthropic、Gemini 三种兼容协议。类型在创建时确定，创建后不可切换；官方地址由前后端共同固定，兼容地址可配置。Provider 支持远程拉取模型 ID 或自定义 ID，多模态能力可通过已知颜色图片的实际识别结果自动探测，也可手动指定；纯文本模型可配置独立的读图 Provider 与模型，运行时先生成图片描述再交给主模型。配置还包含图像模型、API key 环境变量、推理强度、温度和输出 token 上限。模型请求、响应、重试和工具结果写入请求日志，密钥和授权字段必须脱敏；Gemini API key 只能通过请求头发送，不能进入 URL。SDK 隐式重试必须关闭，发送请求与读取响应正文属于同一次显式传输尝试，正文断流按真实尝试记录并重试；取消信号在写入请求日志前检查，429/5xx 退避优先遵守 `Retry-After` 或 `Retry-After-Ms`。

Provider 请求使用应用启动时安装的统一出站 dispatcher。显式代理和标准代理环境变量从 `workspace/secrets/runtime.env` 或进程环境读取；WSL 自动模式仅在没有显式代理时探测当前默认网关。代理选择不改变 OneBot 的 Compose 私有网络或同机宿主网关链路。

OpenAI 官方 Responses 与 Codex Responses 请求必须携带稳定、不可逆且不包含明文身份的 `prompt_cache_key`，按 Provider、模型、行为、记忆类型、完整会话和工具集合分桶；同一工具循环的多轮请求复用同一个键。OpenAI 兼容协议不强制注入该字段，避免不支持扩展字段的服务拒绝请求。静态 system 内容保持在动态会话和用户输入之前，继续使用 Provider 的隐式缓存断点。

模型响应日志保留 Provider 返回的原始 usage，并在日志顶层写入统一的 `tokenUsage`。`tokenUsage` 字段为 `input`、`cachedInput`、`cacheRate`、`output` 和 `total`；日、小时聚合桶在此基础上增加 `requests`：

模型调用通过 `metadata.stage` 归入 `reply`、`orchestrator`、`memory` 或 `other`。记忆调用通过 `metadata.memoryKind` 区分 `working_long_term` 和 `user_profile`；工作记忆合并与长期记忆晋升由同一次 Provider 调用完成，因此统一展示为“工作与长期记忆”，不能虚构或重复计算独立的长期记忆调用。一次 Provider 请求只计入一个行为类别；没有 usage 的失败请求仍计入调用次数，每次实际传输重试分别计数。Deferred Codex 和自拍改写必须保留完整会话、行为阶段和尝试次数上下文。请求日志写入时同步更新 `model_call_aggregates`，全局统计读取全局聚合行，群聊统计使用完整 `conversationId` 读取精确聚合行，不扫描历史日志。

- OpenAI Responses/Codex 使用 `input_tokens`、`input_tokens_details.cached_tokens`、`output_tokens` 和 `total_tokens`；Chat Completions 使用对应的 `prompt_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens` 和 `total_tokens`。输入总量已经包含缓存输入，不能重复相加。
- Deferred Codex CLI 进程实际启动后，无论完成或失败都以 `model.response`、`codex.tool.complete`、`codex-cli` 写入请求日志；usage 可用时使用 `input_tokens`、`cached_input_tokens` 和 `output_tokens`，其中缓存输入是输入总量的子集，总量由输入与输出相加。终态写入竞争、迟到返回和失败状态不能丢弃已经产生的 usage，同一任务尝试只能统计一次。
- Anthropic 输入总量是 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，其中只有 `cache_read_input_tokens` 计入 `cachedInput`；缓存创建属于输入消耗，不属于缓存命中。输出使用 `output_tokens`，总量由输入与输出相加。
- Gemini 输入使用已经包含缓存内容的 `promptTokenCount`，并累加 `toolUsePromptTokenCount`；缓存输入使用 `cachedContentTokenCount`，输出是 `candidatesTokenCount + thoughtsTokenCount`，总量优先使用 `totalTokenCount`，小于归一化输入与输出之和时回退为后者。
- `cachedInput` 是 `input` 的子集，不额外计入 `total`。只有 Provider 明确返回缓存字段的记录才进入缓存率分母；单条记录或聚合桶的缓存率为这些记录的 `ΣcachedInput / Σinput` 并限制在 `0..1`。明确返回缓存字段但分母为 0 时返回 `0`；桶内全部记录都没有缓存字段时返回 `null`。缺失、负数和非有限数按 0 处理，任何 API 与界面值都不能出现 `NaN` 或 `Infinity`。

### 4.2 最终提示词

最终提示词使用 JSON 文档，支持：

- 多条 system、user、assistant 消息；
- 变量槽位；
- 人格变量在所有最终提示词中可用；工作记忆、长期记忆和用户画像召回结果分别使用独立变量；
- function tools；
- JSON Schema response format；
- 管理台编辑、变量表、结构校验、冲突检测和运行时热更新；
- 运行时默认值与 Agent 工作区文件一致性测试。

人格正文保存在 `AGENTS.md`、`SOUL.md`、`PREFERENCE.md`、`USER.md` 和 `RELATION.md`。提示词和人格是小型、可审阅配置文件，不进入 SQLite。

### 4.3 工具

Agent 工具目录固定包含 `assistant_text`、`memory_recall`、`websearch`、`generate_img`、`selfie`、`workspace_bash` 和 `codex` 七项。时间读取、OneBot 消息外发和 Provider 检查属于系统或管理能力，不进入 Agent 工具目录。

`bot.tools.overrides` 按工具名保存稀疏覆盖，每项只允许可选的 `enabled` 与 `description`。没有 `enabled` 覆盖时继承 `conversation.reply` 最终提示词是否包含该 Function；显式启用可恢复代码内置定义，显式停用会从模型请求中移除该工具。描述采用“配置覆盖、当前最终提示词、代码默认值”的优先级；删除描述覆盖后立即恢复当前提示词或代码默认描述。描述覆盖作用于所有 Provider 协议。

工具的配置启用状态与运行能力分开计算。`enabled` 表示配置和提示词选择，`available` 表示当前运行环境、会话权限及依赖能力，`effectiveEnabled` 仅在两者都为真时成立。管理 API 必须同时返回三种状态和不可用原因；平台强制关闭或当前会话无权限时，管理台不能把工具显示成可执行。被停用或不可用的工具既不能出现在 Provider 工具定义中，也不能通过模型返回的未声明 Function Call 绕过门禁执行或派发。

`dispatch_message` 负责 deferred tool 的首次受理消息，`assistant_text` 只负责开始工作后的阶段进度或补充问题，最终结果继续使用普通正文。单轮工具调用上限可配置，默认 20，最大 100；工具启用状态与描述热更新，权限、超时和并发继续由对应运行配置控制。`workspace_bash` 仅供管理员使用，Docker 与 Linux Native 均固定通过 `/usr/bin/bwrap` 执行：宿主文件系统只读，Agent workspace 是唯一可写宿主绑定，沙箱自带的 `/dev` 仅提供非持久设备 I/O；子进程继承相同 mount/PID/IPC/UTS/cgroup 隔离且全部 capability 被丢弃。macOS 原生模式强制关闭该工具。命令与路径规则只作为附加拒绝层；bubblewrap 缺失、不可执行或内核 namespace probe 失败时必须拒绝命令，不能回退到普通 Bash。群聊默认不可用。

Codex CLI 是 Core 的固定版本运行依赖，Docker Core 必须在镜像内安装并通过版本 smoke，Native Core 必须在启动时验证可执行文件。Deferred worker 只从当前 workspace 的 `secrets/codex/auth.json` 复制授权到单次任务隔离目录；管理工具目录与真实回复 Provider 共用同一能力解析器，同时检查 CLI、授权与 Bash 隔离探针并在异常时安全关闭。CLI 缺失或版本不匹配时 Core 拒绝启动，授权缺失时 Core 保持可启动以允许管理员完成设备登录，但 Codex 工具不得被标记为可调用。

## 5. 记忆系统

### 5.1 数据边界

| 来源 | 内容 | 主键和更新方式 |
| --- | --- | --- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件 | 稳定 ID；完整集合替换；快照冲突保护 |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件 | event key 与 fingerprint 合并；保留来源工作记忆 ID |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和明确称呼 | QQ 号聚合；画像中的明确称呼优先，管理员配置作为缺省值 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆压缩、长期记忆晋升和用户画像更新在一个 SQLite 事务中提交，批次 ID 用于幂等重放。

### 5.2 调度

记忆调度器按会话保存待处理消息、静默截止时间、当前批次、失败次数和重试时间。服务重启时，运行中的批次恢复为待处理状态。已提交游标之前的消息不能重复入队。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆、长期记忆和用户画像中搜索。返回结果包含来源、事件时间、用户身份和称呼信息。SQLite 负责持久化和有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- 原文件按内容哈希进入附件缓存。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图压缩、重试和 OneBot 外发。自拍必须使用角色参考图与自拍重写提示词；运行时从当前 Agent workspace 的 `selfie/` 目录读取最多 3 张参考图，并为会话图片保留第 4 个参考位。管理台可在图像页上传、预览和删除这 3 张图片，列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件保存在忽略的运行目录，图片历史元数据保存在主 SQLite 数据库。

出站媒体必须先通过生成图片根目录、直接子文件、PNG 文件名、常规文件和大小校验，再读取为 OneBot `base64://` 内联数据。Native Core 与 Docker Core 使用同一传输方式，NapCat 不读取 Core workspace，不接受共享绝对路径。超过 OneBot 内联预算的文件必须使用独立、鉴权、限流、可过期的传输协议；不能用容器路径或宿主路径作为降级。

NapCat 上报的 QQ 文件优先通过 OneBot action 返回的受控 URL 进入 Core；统一启动器固定开启 `get_file` Base64 回退。仅返回 NapCat 容器内路径时不能由 Core 直接打开，也不能为兼容该路径而挂载业务 workspace；超过现有 action 预算的文件使用后续明确的流式协议。

## 7. 管理台

管理台包含状态、QQ 会话、Web Chat、图片、记忆、提示词、日志和设置页面，支持 light、dark 和跟随系统主题，并适配桌面、平板和移动端。

登录页使用 Sunabot 品牌 Hero 与管理员登录表单组成响应式双栏，移动端按 Hero、表单顺序纵向排列。用户可见文案只保留名称、状态、动作、结果和完成操作所需的提示；页面不得展示鉴权实现、浏览器存储方式、数据来源、区域职责、设计说明或装饰性状态代码。

设置中的 Agent 工具页默认打开“工具目录”Tab，列出七个真实工具的图标、名称、Function 名、摘要、配置状态、运行能力和同步或异步方式，支持搜索、启停与刷新。详情弹层展示实际模型描述、描述来源、JSON Schema 参数与严格模式；编辑模型描述会建立全局覆盖，“恢复继承说明”会删除覆盖。“运行参数”Tab 继续管理单轮调用上限、Tavily、Codex Worker 和图像生成默认值。两个 Tab 共用当前工具配置草稿和保存栏。

状态页使用响应式数据拼盘展示 QQ Bot 头像、昵称、连接状态、内容计数、Provider 健康，以及当日 Token 总量、输入、缓存输入、缓存率、输出和请求数。拼盘保留非对称网格，通过留白、分割线和连续数据区组织信息，不使用圆角卡片逐项装箱。Token 统计使用浏览器传入的时区偏移：当日小时序列固定返回 0—23 点 24 个桶，缺少的小时补零；日历固定覆盖截至当日的最近 53 周本地日期，缺少的日期补零。小时图使用 Token 总量柱形和缓存率折线，缓存率为 `null` 时显示 `--` 且折线跳过该点。四位及以上主指标使用 K 缩写，千分位精确值保留在主数字的悬停提示中，不在数字下方重复显示。

页面信息区默认通过留白、连续网格和 1px 分割线建立层级；按钮、输入控件、消息气泡和必要弹层可使用与语义相称的技术圆角。Boxicon 不使用背景、边框或圆形外壳，44px 点击热区保持透明，需要加强层级时直接放大图标。中文页面标题使用 Space Grotesk Variable 与系统中文字体，运行主状态使用英文并以 Doto Variable 显示，状态页所有大号统计数字统一使用 Doto Variable，标签和元数据使用 Space Mono。

Web Chat 使用固定管理员身份和 `web:admin` 会话，通过 Web delivery adapter 进入与 QQ 相同的 Agent loop、提示词、记忆和同步工具链。Web Chat 回复只能写回浏览器消息流，不能经 OneBot 外发；Web Chat 也不能进入 QQ 会话目录、上线通知或 OneBot 外发目标。当前 Web delivery 没有持久化的异步结果投递目标，因此 Web Chat 不向模型提供 Codex、生图和自拍工具。已经受理的 Web Chat 回合使用服务端超时并按顺序完成，不绑定浏览器请求体或页面生命周期。发送接口拒绝空白正文和超过 16,000 字符的正文，页面支持 Enter 发送、Shift+Enter 换行、发送中状态、错误恢复、非重叠消息轮询和图片缩略图。

日志页按从新到旧提供 Bot 活动终端与分页纵向时间轴，Responses、Codex Provider、Deferred Codex CLI、Chat Completions、Anthropic 和 Gemini 请求同时显示中文标题与原始 action ID，其中 Codex CLI 使用 `codex.tool.complete`。模型响应的统一 `tokenUsage` 使用独立用量条展示，原始请求、响应和 usage 字段继续使用递归结构化视图，不能退回整段 JSON 文本。日志页汇总回答、群聊编排、记忆压缩和其他模型调用的次数与 Token；记忆压缩区分工作与长期记忆、用户画像。非私聊会话详情显示会话累计消息数、当前保留消息数、可见消息数、用户消息数、回答数、内部消息数，以及同口径模型调用统计；页面可见且会话已选中时每 10 秒刷新统计。Bot 消息气泡显示消息来源、本轮实际工具和请求日志入口，工具图标不使用背景或边框，窄屏时允许整行换行。记忆页一次只查看一个真实来源，单个搜索栏在本地筛选与语义召回间切换。提示词编辑器提供变量表、已使用变量状态、可选 XML 包装，以及离开前保存；已登记变量引用复用 inline code 的底色与文字样式，未登记变量保持普通文本样式。

图片列表和会话正文先读取 48px 低质量 WebP 占位图并以高斯模糊显示，再淡入 480px WebP 展示图；用户打开预览或原图链接时才读取完整图片。浏览器缓存已加载资源，图片历史在短期页面切换中复用，返回图片页不重新批量请求占位图和历史数据。

QQ 登录由管理台完成：离线时直接显示 NapCat 当前二维码并每 2 秒拉取新状态，二维码轮换后页面自动替换；用户可以主动刷新二维码。在线时显示当前账号并提供带确认的退出操作，退出后 NapCat 自动回到扫码态。扫码成功后 Core 保存新的 `NAPCAT_ACCOUNT`，清理临时二维码和手动登录标记，后续重启恢复快速登录。该流程不得依赖 Agent、终端命令或打开 NapCat 原生 WebUI；原生 WebUI 只保留为故障诊断入口。

管理台页面脚本随主应用一次加载，路由切换不得再请求页面脚本分块；鉴权启动期间使用统一加载状态。字体与图标由构建产物本地提供，不依赖外网字体服务；带内容哈希的构建资源使用长期缓存，入口 HTML 禁止长期缓存。浏览器不得因等待脚本或原图而表现为点击无响应。

管理 API、生成图片和管理台数据使用管理员账号密码建立的 HttpOnly 会话鉴权；Cookie 最长保留 30 天，空闲 7 天失效，服务端以 SHA-256 哈希在主库持久化会话，Core 重启后继续识别。写操作还必须通过 CSRF 与 Origin 白名单校验。设置页提供管理员密码修改，成功后轮换当前 Cookie 与 CSRF Token、清除其他会话并保持当前浏览器登录。Bearer Token 仅用于受控自动化客户端，本机回环请求不绕过认证。远程入口包含单来源锁定、全局自动熔断和文件型手动熔断。远程图片代理必须执行协议、域名、DNS、重定向、响应类型、content-length、总字节数和超时校验。

## 8. SQLite 持久化

### 8.1 主库

默认路径：`workspace/business/data/sunabot.sqlite`。可通过 `SUNABOT_DATABASE_PATH` 覆盖。

主库启用 WAL、`synchronous=NORMAL`、外键和 5 秒 busy timeout。当前表如下：

| 表 | 数据 |
| --- | --- |
| `app_metadata` | schema 与旧数据导入标记 |
| `conversations` | 会话及其消息数组，每个会话一行 |
| `memory_records` | 工作记忆、长期记忆和用户画像 |
| `memory_batches` | 已提交记忆批次及幂等结果 |
| `memory_scheduler` | 各会话的记忆待处理队列与重试状态 |
| `request_logs` | 脱敏后的模型、工具和运行日志；保留原始 usage 与统一 `tokenUsage`，日/小时聚合在读取时派生 |
| `image_history` | 生成图片历史元数据 |
| `admin_sessions` | 管理 Cookie 哈希、CSRF Token、访问时间与有效期 |

`workspace/business/data/session-queue.sqlite` 独立保存会话事件、turn、异步任务和 outbox。附件缓存中的每个 `chunks.sqlite` 独立保存该文件的文本分块。

### 8.2 文件边界

以下内容继续使用文件：

- `workspace/secrets/runtime.env`：本机凭据，不进入 Git；
- `workspace/business/config/sunabot.json`：应用配置，包括 `bot.tools.overrides` 中的工具启用与描述稀疏覆盖，不保存明文密钥；
- `workspace/business/agents/<agentId>/`：Agent 人格、提示词和人工维护文件；
- `workspace/business/media/`：需要随业务恢复的图片和持久附件；
- `workspace/runtime/napcat/`：所有平台的 NapCat Docker 配置、QQ 登录态与运行状态；配置唯一目录为 `workspace/runtime/napcat/config-full`，QQ 状态位于 `workspace/runtime/napcat/qq`，登录二维码唯一文件为 `workspace/runtime/napcat/qrcode.png`；该目录挂载给 NapCat 容器，不作为 Core 的媒体共享目录；
- `workspace/runtime/napcat/manual-login-required`：用户从管理台退出 QQ 后的临时标记；NapCat 重启时据此跳过快速登录，扫码成功后自动删除；
- `workspace/cache/`：可重建缓存，不进入快照；
- Agent 人格和最终提示词：需要人工审阅和管理台编辑；
- 单个附件 manifest、好友/群目录缓存：体积小且可重建；
- 图片与文档二进制：文件系统更适合流式访问；
- Codex JSONL：子进程通信协议，不是持久化引擎。

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

## 9. 配置与安全

- Provider key、Tavily key、OneBot token 和自动化管理令牌只能通过 `workspace/secrets/runtime.env` 或进程环境变量提供。
- Git 不跟踪整个 `workspace/`，其中包括环境变量、配置、Agent 人格、SQLite、WAL、日志、缓存、QQ 登录态、生成图片和备份。
- 浏览器管理台不得把账号、密码、Bearer Token 或会话密钥写入 localStorage/sessionStorage。
- 请求日志递归脱敏授权、token、password、secret 和常见 key 字段，并限制长字符串。
- OneBot、跨组件媒体和 Agent 文件写入均执行身份、大小与路径边界校验；OneBot action 不能携带 Core 或 NapCat 的绝对文件路径。

## 10. 功能—代码文件索引

| 功能 | 主要代码 |
| --- | --- |
| 服务启动入口 | `apps/api/main.ts` |
| Node 版本一致性门禁 | `.node-version`, `.nvmrc`, `tooling/runtime/node-version-contract.mjs`, `tooling/runtime/validate-contract.mjs` |
| 出站代理解析与安装 | `packages/platform/proxy.mjs`, `deploy/runtime-contract.json` |
| API 组合、生命周期、静态站点与错误映射 | `apps/api/server.ts` |
| 管理鉴权 API | `apps/api/plugins/authRoutes.ts` |
| Provider、Codex 授权与配置 API | `apps/api/plugins/providerConfigRoutes.ts` |
| OneBot 管理 API | `apps/api/plugins/onebotRoutes.ts` |
| 记忆管理 API | `apps/api/plugins/memoryRoutes.ts` |
| 状态与监控 API | `apps/api/plugins/monitoringRoutes.ts` |
| 会话与会话日志 API | `apps/api/plugins/conversationRoutes.ts` |
| Web Chat 管理员会话与浏览器 delivery | `services/webChat/`, `apps/api/plugins/conversationRoutes.ts` |
| 图片、缩略图、Token/模型调用统计、请求日志与图片测试 API | `apps/api/plugins/mediaRoutes.ts`, `apps/api/plugins/conversationRoutes.ts`, `src/modelCallStats.ts`, `src/requestLog.ts`, `adapters/sqlite/applicationDataStore.ts` |
| Agent 文件与工具目录 API | `apps/api/plugins/agentToolRoutes.ts`, `services/tools/toolRegistry.ts` |
| 自拍参考图 API 与受控文件仓库 | `apps/api/plugins/selfieReferenceRoutes.ts`, `src/admin/selfieReferences.ts` |
| 配置加载、默认值、路径解析 | `src/config.ts`, `src/types.ts` |
| SQLite 主库 | `adapters/sqlite/applicationDataStore.ts` |
| OneBot 连接、事件和 action | `adapters/onebot/onebotGateway.ts`, `adapters/onebot/qqMedia.ts` |
| 回复运行时、上下文、群聊总结 | `src/runtime.ts` |
| 会话事件、turn、工具任务、outbox | `services/sessions/`, `packages/contracts/session/runtimeMessages.ts` |
| 群聊门控与编排策略 | `services/orchestration/groupReplyPolicy.ts` |
| 命令路由与钩子 | `services/messaging/commandRouter.ts`, `services/messaging/hookBus.ts` |
| Provider、模型发现、多模态探测与工具循环 | `adapters/model/openaiProvider.ts`, `adapters/model/providerDiscovery.ts`, `adapters/model/provider/`, `services/tools/` |
| Codex 异步工具 | `adapters/codex/codexTool.ts` |
| 联网搜索 | `adapters/model/webSearchTool.ts`, `adapters/model/webSearchSettings.ts` |
| Bash、图像生成、自拍 | `services/tools/bashTool.ts`, `services/tools/generateImgTool.ts`, `services/tools/selfieTool.ts` |
| 图片重试和外发 | `adapters/model/imageGenerationRetry.ts`, `services/delivery/outboundMedia.ts` |
| 人格与提示词 | `services/agent/` |
| 记忆 CRUD、合并、召回和批次 | `services/memory/` |
| 记忆调度 | `services/memory/memoryScheduler.ts` |
| 附件接入、解析、缓存和上下文 | `services/media/attachments/` |
| 会话目录和显示名 | `services/conversations/conversationDirectory.ts`, `services/conversations/senderName.ts` |
| 管理配置和 Agent 文件 | `src/admin/` |
| 管理台路由和页面 | `apps/admin-web/src/router.ts`, `apps/admin-web/src/views/` |
| 管理台组件和状态 | `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| Agent 工具目录设置 | `apps/admin-web/src/components/settings/ToolsSettingsForm.vue`, `apps/admin-web/src/components/settings/ToolCatalogSettings.vue`, `apps/admin-web/src/components/settings/ToolDetailDialog.vue`, `apps/admin-web/src/components/settings/ToolRuntimeSettings.vue`, `apps/admin-web/src/composables/useToolCatalog.ts` |
| 自拍参考图设置 | `apps/admin-web/src/views/ImagesView.vue`, `apps/admin-web/src/components/settings/SelfieReferenceSettings.vue`, `apps/admin-web/src/components/settings/SelfieReferenceDialog.vue`, `apps/admin-web/src/composables/useSelfieReferences.ts` |
| 日志与群聊模型调用统计 | `apps/admin-web/src/components/logs/ModelCallStatsPanel.vue`, `apps/admin-web/src/views/LogsView.vue`, `apps/admin-web/src/components/conversations/ConversationThread.vue` |
| 旧数据迁移 | `tooling/migrations/migrate-to-sqlite.mjs` |
| 统一运行入口与模式选择 | `sunabot.sh`, `tooling/runtime/launcher.mjs`, `tooling/runtime/launcher-core.mjs` |
| Core 与 NapCat Docker 编排 | `deploy/docker/compose.yml`, `deploy/docker/Dockerfile`, `deploy/docker/Dockerfile.napcat`, `tooling/runtime/configure-napcat-client.mjs` |
| macOS/WSL/Linux Native Core | `tooling/runtime/launcher.mjs`, `tooling/runtime/macos.mjs` |
| 单元与集成测试 | `tests/unit/`, `tests/integration/` |
| 浏览器与生产测试 | `tests/e2e/`, `playwright.config.ts` |

## 11. 验证标准

交付前必须通过：

```bash
npm run runtime:contract
npm run check
npm test
npm run build
npm run test:e2e
```

涉及界面时还要运行视觉测试并检查截图；Web Chat 必须覆盖管理员身份、Web/QQ 外发隔离、消息轮询、发送校验、键盘操作、图片缩略图和移动端布局。涉及数据迁移时必须核对迁移脚本输出、SQLite 表记录数、旧文件备份和服务重启后的 API 与 OneBot 状态。

Token 统计验收必须覆盖 OpenAI Responses、Deferred Codex CLI 成功与失败结果、Chat Completions、Anthropic 和 Gemini 的原始 usage 夹具，验证缓存输入不重复计数、Codex CLI 失败 usage 不丢失、Anthropic 三类输入求和、思考 Token 归入输出、缓存率分母只包含明确报告缓存字段的记录、无缓存字段返回 `null`、显式零缓存返回 `0`、时区跨日、24 个小时桶和最近 53 周日期范围。行为统计必须验证回答、编排器、记忆总量与两类真实记忆拆分无重复计数，并验证 `conversationId` 精确隔离。管理台测试必须验证 371 个日历单元、24 个小时柱、缓存率折线不产生 `NaN`/`Infinity`，并分别检查移动端与桌面端的 light/dark Token 卡片、行为统计、群聊详情、日历、小时图和展开后的结构化 usage 日志截图。

涉及跨平台运行时还要执行 `./sunabot.sh doctor`，分别验证 Native Core + NapCat Docker 与 Docker Core + NapCat Docker 的启动、停止、单实例、OneBot token、文字、图片、文件和重启恢复。contract 与测试必须拒绝 NapCat 并入 Core、OneBot 复用管理端口、跨组件共享绝对路径和旧新运行时并行。
