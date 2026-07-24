# LLM 节点 Token 消耗与 Prompt Cache 审计

日期：2026-07-23
代码基线：`start-dev` 当前共享工作树
真实数据截止：2026-07-22T17:50:44.292Z
审计范围：Plana、Arona、Koharu 的文本模型、图像模型、异步 Codex、相关 Provider 请求与当前缓存机制

## 1. 结论摘要

当前三套业务库在固定截止点内共有 8,613 条 `model.response`，其中 5,629 条带可归一化 usage。可计量样本累计输入 46,861,152 Token、输出 2,120,303 Token、总计 48,981,455 Token；Provider 明确回报的缓存输入为 4,680,960 Token，按 `ΣcachedInput / Σinput` 计算的真实缓存率为 10.0%。其余 2,984 次响应没有 usage，主要集中在超时、Provider 错误和图像请求，不能按零消耗处理。

Token 主要集中在四条链路：群聊主回复、用户群聊编排器、工作/长期记忆合并、用户画像，合计占可计量总 Token 的 85.6%。当前优化优先级应集中在这些节点，避免对低频小节点做大量局部压缩却不改变总体成本。

缓存能力本身可以工作。隔离的 `gpt-5.6-luna` 合成请求使用同一个审计 cache key 和约 5.4K 输入 Token，cold、warm-1、warm-2 的缓存输入依次为 0、0、4,864，warm-2 实际缓存率为 89.17%；只改变首个 developer 前缀后缓存立即回到 0。生产环境低命中的主因包括动态内容进入首个缓存前缀、cache key 变体过多、工具和 schema 身份变化、旧模型按 conversation 隔离 key、请求密度不足与缓存机会性建立。

审计截止点的群聊回复存在已确认的结构缺陷：`memory.long_term` 位于 system 消息中，而 Codex GPT-5.6 会把全部 system 内容合成首个 developer input，并以完整 system 文本参与 cache key。长期记忆每次变化都会同时改变请求前缀和 key。Plana、Arona、Koharu 的 1,144 次可分析 developer-first 群聊请求分别产生 180/397/142 个 system 前缀变体；在只读分析中将长期记忆替换成固定占位后，变体降至 15/21/10。该缺陷已于 2026-07-23 在公共模板、Agent override、源默认模板和保留式迁移中修复，同时将可热更新的 `persona.air` 移出单聊、群聊和 Tone 的 system 缓存前缀；表内历史数据仍保持审计截止点口径。

失败请求是第二个成本盲区。群聊 Thread 分类在样本中有 547 次响应、544 次错误；工作/长期记忆有 1,348 次响应、1,039 次错误；Director 每日计划有 52 次响应、42 次错误。大量失败没有 usage，但请求已经发送，账单和服务端实际消耗可能大于当前仪表盘展示值。

现有统计只能稳定区分 `reply`、`orchestrator`、两类 `memory` 和 `other`。Tone、Dream、Director、AIR、Bash 审计、Config Doctor、自拍改写、视觉探测、Provider 探针与图像请求会被合并、继承父 stage 或落入 `other`，无法回答“每个功能节点一次业务调用花了多少”。缓存写入 Token 虽会参与内部 `cacheReported` 判断，却没有进入公开 usage、SQLite 聚合和管理台；GPT-5.6 官方 API 的 cache-write 成本因此不可见。

## 2. 审计口径与证据边界

### 2.1 三条证据线

1. 代码与夹具：追踪所有 `completePrompt`、`completeRequest`、`completeRequestTurn`、`generateImage`、异步 Codex 和 Provider 探针入口；执行现有 Prompt Cache、Codex Responses 与 usage 归一化测试。
2. 真实低价请求：使用 `gpt-5.6-luna`、独立审计 cache key、固定合成文本、无工具、无业务内容、无 QQ I/O，执行 cold/warm/前缀扰动矩阵。
3. 真实请求抽样：对三套 `sunabot.sqlite` 使用只读查询，按 `model.response` 统计物理请求尝试，按 stage、prompt family、memory kind、模型和 runId 交叉分析。

### 2.2 指标定义

- 单次请求：一条 `model.response`，每次真实 transport retry 分开计数。
- 单次业务调用：同一功能入口的一次逻辑运行。当前只有部分节点完整携带 `runId`，因此主表使用单次请求口径，另行报告可识别的逻辑运行倍率。
- API 缓存率：仅对 Provider 明确回报缓存字段的记录计算 `ΣcachedInput / Σinput`。缓存输入已经包含在 input 中，不重复计入 total。
- Prefix 复算：使用已脱敏的实际 Provider request，按 provider、model、prompt family、工具 digest 和 response schema digest 分桶；比较从第一个缓存段开始的连续精确相等段，并单独记录首段内容 digest、cache key 复用和变体数。
- Token prefix 估算：当前仓库没有与 `gpt-5.6-*` 完全匹配的 tokenizer。字符/字节比例只能表示潜力，不能代替 Provider 的 `cached_tokens`。严格 Token 边界仍是 `0..input_tokens`。

### 2.3 样本限制

- 样本窗口分别从 2026-07-11、07-13、07-17 开始，截止时间统一冻结为 2026-07-22T17:50:44.292Z。运行中的 Core 在审计期间继续写日志，所有报告数字都按该截止点冻结。
- 5,629 条带 usage 的记录代表“成功返回可计量 usage 的请求”。无 usage 的失败请求可能已经产生服务端消耗，成功样本均值存在向下偏差。
- 图像输出按图片模型、尺寸和质量计费，不能用文本 Token 完整表示；语音合成也需要单独的字符/音频计费口径。
- 外部 MCP、Skill 或 Web 服务内部再次调用 LLM 时，Sunabot 本地日志不可见，需要在外部服务侧审计。
- 本轮只有 Codex 订阅 Provider 可用于真实合成请求，没有 OpenAI 官方 API key，因此 OpenAI 官方 Responses 的显式 breakpoint 仍需独立实测。
- 当前共享工作树含其他 Codex 会话的未提交变更。本审计没有吸收、整理或提交这些改动。

### 2.4 全量功能节点清单

| 功能节点 | 当前触发与模型路径 | 一次业务事件的模型请求形态 | 当前统计状态 |
| --- | --- | --- | --- |
| 私聊、群聊、Web Chat、异步 callback 主回复 | `src/runtime/reply.ts`，默认 Provider；工具循环在 `adapters/model/provider/completion.ts` | 1–21 个模型轮次，每轮还可能 transport retry | 归 `reply`，可见物理请求，逻辑总量不完整 |
| 群聊总结 | 群聊命令，`conversation.group-summary`，默认主模型 | 通常 1 个 completion | 归 `reply`，样本期没有可稳定单列的量 |
| 用户群聊主动编排器 | `src/runtime/orchestration.ts`，当前主要为 `gpt-5.4-mini` | 最多 4 次完整逻辑尝试 | 归 `orchestrator`，可单列 family |
| 群聊 Thread 分类 | `src/runtime/groupThreadPipeline.ts`，当前为 `gpt-5.6-luna` | 每个回复最多 4 个批次，每批 1 次 completion | 归 `orchestrator`，可单列 family；样本期几乎全部失败 |
| Tone | `src/runtime/tone.ts`，按 Agent 跟随主模型或独立模型 | 每个非空外发文本 1 次；多条中间消息会重复触发 | 聚合落入 `other`，原始日志可按 `stage=tone` 复算 |
| 工作与长期记忆 | `src/runtime/memoryPipeline.ts`，`memoryModel` | 每个 memory batch 1 次，CAS 冲突可重做 | 可见 `memoryKind=working_long_term`，runId 不完整 |
| 用户画像 | `src/runtime/memoryPipeline.ts`，`memoryModel` | 每个参与者 batch 通常再执行 1 次 | 可见 `memoryKind=user_profile` |
| Dream | `src/runtime/dreamPipeline.ts`，`memoryModel` | 每 Agent 每日一次，retryable 错误最多 3 次 | stage 为 memory，但没有 memoryKind，聚合落入 `other` |
| Director 每日计划 | `src/runtime/director.ts`，默认 Provider | 每 Agent 每日一次；历史确定性错误曾被周期重试 | 聚合落入 `other`，原始 family 可识别 |
| `call_director` 日程修订 | 主回复工具内进入 `src/runtime/director.ts` | 主模型轮次 + Director 子调用 + 主模型续轮 | 子调用落入 `other`，父子成本未关联 |
| Director 主动分享 | 定时 callback 进入完整主回复并要求自拍 | 每个目标会话分别执行主回复、自拍、图片、续轮和 Tone | fan-out 未形成独立成本桶 |
| `read_air` | 主回复工具内进入 `src/runtime/air.ts`，默认 Provider | 主模型轮次 + AIR 子调用；CAS 冲突最多完整重做一次 + 主模型续轮 | 原始 `stage=read_air` 可识别，聚合落入 `other` |
| 普通 `generate_img` | 主模型选择工具后进入 `adapters/model/provider/imageGeneration.ts` | 主模型轮次 + image Provider + 主模型续轮 | 图片模型、图片价格与文本 usage 未分离 |
| 自拍 | `src/runtime/selfie.ts` | 主模型轮次 + 文本 prompt 改写 + image Provider + 主模型续轮 | 改写继承父 stage，仅靠 family 分离 |
| 管理台表情生成 | `apps/api/plugins/emojiRoutes.ts`，直接 image Provider | 1 次图像请求，最多 3 张角色参考图 | 有 `emoji_generation` metadata，缺少统一图片成本 |
| 管理台 image playground | `apps/api/plugins/mediaRoutes.ts`，直接 image Provider | 1 次图像请求 | 没有稳定 stage/family |
| 视觉 fallback 描述 | `src/runtime/lifecycle.ts`，独立 vision Provider/model | 含图主请求前额外 1 次 completion | 继承父日志上下文，无法直接分离 |
| 多模态能力探测 | `src/runtime/lifecycle.ts`、`adapters/model/providerDiscovery.ts` | 每个 Provider 配置进程内最多 1 次 completion | 无独立 stage/family，混入 `other` |
| 异步 Codex | `services/sessions/sessionToolJobProcessor.ts`、Codex CLI | 主模型受理 + 独立 CLI 内多轮 + callback 主回复 | 有 CLI usage 时可计量，缺少内部轮次与父任务维度 |
| Bash 安全审计 | `services/tools/bashAudit.ts`、`apps/api/bashAuditRuntime.ts` | 每次真实 Bash 工具调用额外 1 次 completion | `stage=bash_audit` 可从原始日志识别，聚合落入 `other` |
| Config Doctor AI | `src/admin/configDoctor.ts`、`apps/api/server.ts` | 管理员显式触发 1 次，无工具 | `stage=config_doctor` 可识别，聚合落入 `other` |
| Provider 测试/健康探针 | `adapters/model/openaiProvider.ts` | 非 OpenAI 官方 Provider 发送一次 `ping` completion；OpenAI 官方只调用 models list | 无稳定业务 stage，污染 `other` |
| 在线语音合成 | `src/runtime/voice.ts`、`adapters/voice/openAiSpeechClient.ts` | TTS Provider 请求，不产生文本 LLM Token | 需要字符数/音频时长/语音价格指标 |
| 普通定时任务生成 | `src/runtime/scheduledTasks.ts` | 当前代码只渲染 callback；到期后复用主回复 | 不应另算独立 LLM 节点；历史日志存在旧 `scheduled_task` 记录 |
| 外部 MCP/Skill 内部模型 | Sunabot 只看见工具请求和结果 | 取决于外部服务 | 本地不可见，需要外部账单与 trace |

## 3. 真实消耗与缓存率

### 3.1 总体

| 指标 | 结果 |
| --- | ---: |
| `model.response` 总尝试 | 8,613 |
| 带 usage 的可计量尝试 | 5,629 |
| usage 覆盖率 | 65.4% |
| 输入 Token | 46,861,152 |
| 输出 Token | 2,120,303 |
| 总 Token | 48,981,455 |
| Provider 缓存输入 | 4,680,960 |
| API 缓存率 | 10.0% |

不能直接对 `model_call_aggregates` 全表求和。相同 measurement 会同时写入 `conversation_id=''` 全局行和具体 conversation 行，未限定全局行会产生重复统计。本报告从原始 `model.response` 重新聚合。

### 3.2 主要节点的请求级消耗

以下均值只覆盖带 usage 的请求；P50/P90 为相同 stage/model 的真实分布。

| 节点 / 模型 | 有 usage N | 平均 input | 平均 output | 平均 total | P50 total | P90 total | API 缓存率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 群聊/私聊 reply · `gpt-5.6-terra` | 1,284 | 约 14,369 | 约 141 | 14,509 | 13,332 | 21,534 | 8.8% |
| 群聊/私聊 reply · `gpt-5.6-sol` | 161 | 约 16,823 | 约 310 | 17,133 | 18,321 | 23,710 | 5.5% |
| 用户群聊编排 · `gpt-5.4-mini` | 2,793 | 约 4,967 | 约 219 | 5,186 | 5,380 | 6,678 | 17.4% |
| 编排器 · `gpt-5.6-luna` | 112 | 约 4,940 | 约 141 | 5,081 | 5,746 | 5,974 | 7.4% |
| 工作与长期记忆 · `gpt-5.6-luna` | 347 | 约 17,214 | 约 2,645 | 19,859 | 19,815 | 25,438 | 3.6% |
| 用户画像 · `gpt-5.6-luna` | 326 | 约 8,536 | 约 587 | 9,123 | 9,778 | 11,455 | 3.5% |
| Tone · `gpt-5.6-terra` | 263 | 约 3,010 | 约 72 | 3,081 | 2,915 | 3,630 | 14.4% |
| 异步图片链路 · `gpt-5.6-terra` | 122 | 约 6,653 | 约 408 | 7,061 | 5,150 | 11,089 | 1.3% |

按更精确的 prompt family 拆分后：

| 功能节点 | 尝试 / 有 usage | 平均 input | 平均 output | 平均 total | API 缓存率 | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 群聊回复 · terra | 1,075 / 1,041 | 14,949 | 132 | 15,081 | 8.1% | 总 Token 占 32.0% |
| 群聊回复 · sol | 112 / 110 | 18,925 | 229 | 19,154 | 1.9% | 更高输入，缓存更低 |
| 私聊回复 · terra | 152 / 146 | 14,465 | 132 | 14,598 | 15.1% | 私聊模板已把记忆放在末端 user 消息 |
| 私聊回复 · sol | 28 / 27 | 15,328 | 259 | 15,587 | 0% | 样本较少 |
| 用户群聊编排 · mini | 3,631 / 2,712 | 5,054 | 220 | 5,274 | 17.6% | 总 Token 占 29.2% |
| 用户群聊编排 · luna | 113 / 110 | 5,014 | 139 | 5,153 | 7.5% | 小样本 |
| 群聊 Thread 分类 · luna/mini | 547 / 2 | 916 | 159 | 1,075 | 0% | 544 次错误；均值仅来自 2 条 luna usage |
| 工作与长期记忆 · luna | 1,348 / 309 | 17,809 | 2,620 | 20,429 | 3.7% | 1,039 次错误 |
| 用户画像 · luna | 308 / 306 | 8,926 | 609 | 9,535 | 3.5% | 一次记忆 batch 通常还会执行上一节点 |
| Tone · terra | 272 / 263 | 3,010 | 72 | 3,081 | 14.4% | 每个非空外发文本的条件乘数 |
| 自拍改写 · reply/terra | 39 / 39 | 2,485 | 449 | 2,934 | 9.0% | 后续还有图像请求和主模型续轮 |
| 自拍改写 · async/terra | 51 / 41 | 2,122 | 441 | 2,562 | 12.4% | 10 次错误 |
| Dream · luna | 23 / 3 | 34,162 | 1,621 | 35,783 | 0% | 20 次错误，均值只来自 3 条 usage |
| Director 每日计划 · terra | 52 / 10 | 2,399 | 2,182 | 4,580 | 0% | 42 次 schema 错误 |
| `read_air` · terra | 2 / 2 | 3,542 | 1,130 | 4,671 | 0% | CAS 冲突可完整重做一次 |
| Bash 审计 · mini | 20 / 20 | 577 | 339 | 915 | 0% | 每次 Bash 工具调用的附加模型请求 |
| Config Doctor · terra | 3 / 3 | 463 | 33 | 496 | 0% | 管理员显式触发 |

### 3.3 组合后的单次业务成本

以下为条件性估算，用于理解业务流程的乘数，不代表每条消息都会经过全部节点：

- 一条经过用户群聊编排、群聊主回复和 Tone 的普通群聊回复，典型请求级总量约为 `5.3K + 15.1K + 3.1K = 23.5K Token`，尚未计入 Thread 分类、工具续轮、图片、AIR、Bash 审计和记忆 batch。
- 一次记忆 batch 通常包含工作/长期记忆和用户画像两次请求，成功样本合计约 30.0K Token。
- 一次 `read_air` 至少形成“主模型工具轮 → AIR 4.7K → 主模型承接工具结果”，随后还可能执行 Tone。CAS 冲突时 AIR 完整重做。
- 一次自拍通常形成“主模型 → 自拍改写约 2.6K–2.9K → 图像模型 → 主模型续轮 → Tone”。图像价格和视觉输入没有完整进入 Token 表。
- Director 主动分享会对每个目标会话分别进入完整主回复/自拍链路，成本随目标会话数线性增长。
- 主回复工具上限默认 20 次，理论上可产生 21 个模型轮次；每个轮次还可能发生 transport retry。当前没有按逻辑 turn 设置总 Token 或总请求预算。

## 4. 失败、重试与未计量消耗

| 节点 | response attempts | 有 usage | 明确错误 | 错误率 | 主要错误 |
| --- | ---: | ---: | ---: | ---: | --- |
| 群聊 Thread 分类 | 547 | 2 | 544 | 99.5% | 5 秒超时 |
| 用户群聊编排等 orchestrator | 4,394 | 2,905 | 1,488 | 33.9% | 8 秒、5 秒超时 |
| memory | 1,750 | 676 | 1,074 | 61.4% | 90 秒节点超时、60 秒 transport 超时 |
| reply | 1,475 | 1,387 | 42 | 2.8% | fetch/60 秒/300 秒超时 |
| Director | 52 | 10 | 42 | 80.8% | `director_daily_plan` schema 400 |
| async image | 149 | 127 | 16 | 10.7% | 自拍 schema 400、生图失败 |

可按 `runId` 还原的用户编排器共有 2,978 个逻辑 run、3,847 次尝试，平均 1.29 次响应/run，17.6% 出现调用级重试；reply 有 1,107 个 run、1,475 次尝试，平均 1.33 次响应/run。memory 大部分记录没有 `runId`，无法可靠计算一次业务任务在重试后的真实总消耗、最终成功率和每任务成本。

失败记录缺少本地预测 input Token。Provider 没有返回 usage 时，当前统计只能增加请求数，无法估算已发送提示词可能产生的成本。高失败率节点会让仪表盘呈现“请求很多、Token 很少”的假象。

## 5. Prompt Cache 机制与 Prefix 复算

### 5.1 当前实现

- OpenAI 官方 Responses 和 Codex Responses 会发送不可逆的 `prompt_cache_key`。
- cache key 当前包含 Provider、模型、stage、prompt family、memory kind、所谓 static prefix、完整工具定义和 response schema 的 digest。
- 对 `gpt-5.6+` 的 OpenAI/Codex 请求，代码允许跨 conversation 复用 key；旧模型会把 conversation ID 加入 key。
- OpenAI 官方 GPT-5.6 可在最后一个前导 system/developer 内容块设置显式 breakpoint。
- 当前 Codex Responses 后端拒绝 `prompt_cache_breakpoint` 和 `prompt_cache_options`，因此 Codex 路径只发送 key 并依赖后端隐式缓存。
- Anthropic adapter 没有发送 `cache_control`；Gemini adapter 没有建立或引用 `cachedContent`；OpenAI-compatible Chat 没有注入 cache key。三者当前只会被动解析 Provider 可能返回的缓存 usage。

OpenAI 当前文档要求至少 1,024 Token 才有缓存资格，并要求从提示词开头精确匹配；静态内容应位于前部，动态内容放在后部。`prompt_cache_key` 只帮助路由到相同缓存，不能替代精确前缀。GPT-5.6 系列还会回报 `cache_write_tokens`，官方 API 的 cache write 按 1.25 倍未缓存输入价格计费。参见 [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)。

### 5.2 生产 Prefix 复算

本次复算算法如下：

1. 从每条 `model.request` 提取 Provider 实际缓存表面：Responses/Codex 使用首个 instructions 或 system/developer input、后续 input、tools 与 text/schema；Chat 使用 messages、tools 与 response format；Anthropic 使用 system、tools 与 messages；Gemini 使用 systemInstruction、tools 与 contents。
2. 以 `agent + provider + model + promptFamily + toolDigest + schemaDigest` 分桶，防止把工具或结构化输出不同的请求误判为同一前缀。
3. 在同一桶内按时间排序，对当前请求与热窗口内最近请求比较。只有从第 0 段开始连续完全相同的段才计入严格 LCP；首段发生变化时，严格可复用前缀记为 0。
4. 分别计算 key-aware 与 key-agnostic 结果。key-aware 还要求 `prompt_cache_key` 相同，代表当前路由机制下的可达潜力；key-agnostic 只表示重新设计 key 后可能利用的结构潜力。
5. Provider `cached_tokens` 始终作为真实命中。无匹配 tokenizer 时，LCP 只报告精确段数、字节数和 digest 复用，不把字符比例伪装成精确 Token。
6. 图片内容只比较经过日志安全投影后的身份摘要；包含图片的请求不输出正文，也不据此估算视觉 Token。

| 节点 / 模型 | 首 developer 请求 | 不同精确首前缀 | 落在重复前缀的请求 | API 缓存率 |
| --- | ---: | ---: | ---: | ---: |
| reply · terra | 1,262 | 716 | 55.2% | 8.8% |
| memory · luna | 1,702 | 33 | 99.7% | 3.6% |
| Tone · terra | 272 | 10 | 99.6% | 14.4% |
| orchestrator · mini | 3,381 | 10 | 99.9% | 17.4% |
| orchestrator · luna | 618 | 4 | 100% | 7.4% |

精确首前缀重复是必要条件，仍不能直接推断命中。cache key、工具/schema、缓存资格长度、请求到达时间、后端容量和机会性建缓存都会影响实际结果。memory 的 system 前缀高度稳定而实际缓存仅 3.6%，说明只看前缀文本会明显高估命中。

### 5.3 群聊长期记忆破坏缓存

审计截止点的公共 `conversation_group_reply.json` 和 Arona、Koharu override 把 `memory.long_term` 放进 system；工作记忆和用户画像位于历史消息之前的 developer 消息。私聊模板把三类记忆放在末端 user 消息，私聊 terra 的真实缓存率为 15.1%，高于群聊 terra 的 8.1%。2026-07-23 的修复将单聊和群聊统一为稳定 system、`messages_64`、低频配置、每日行程、每轮群聊上下文、AIR/三类记忆、时间与当前输入的顺序；后续真实缓存率需要使用修复后的新请求窗口重新统计。

| Agent | 群聊请求 | system 前缀变体 | cache key 变体 | 移除长期记忆值后的前缀变体 | 再计工具/schema 的 identity 变体 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plana | 261 | 180 | 178 | 15 | 33 |
| Arona | 659 | 397 | 403 | 21 | 47 |
| Koharu | 224 | 142 | 148 | 10 | 23 |

每个 key 平均只有约 1.4–1.6 个请求，常常刚完成 cold 请求便切到新 key。长期记忆是最大变体来源，工具集合与 response schema 是第二层来源。修复时必须同时移动动态内容和收敛 cache identity；只从 key 哈希中删掉记忆、仍把记忆放在首个 developer 内容里，会让不同前缀共用同一 key，无法形成有效命中。

### 5.4 真实合成 API 结果

测试使用 `gpt-5.6-luna`、同一随机审计 key、稳定 developer 前缀、变化的短 user 尾部，无 tools：

| 请求 | input | cached | cache write | output | 延迟 | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| cold | 5,455 | 0 | 0 | 204 | 5.9s | 未命中 |
| warm-1 | 5,455 | 0 | 0 | 341 | 8.6s | 仍未命中 |
| warm-2 | 5,455 | 4,864 | 0 | 152 | 4.5s | 89.17% 命中 |
| 首段扰动 | 5,462 | 0 | 0 | 92 | 3.3s | 精确前缀失配 |

该实验确认三件事：Codex 后端能够缓存长稳定前缀；首次 warm 请求仍可能为零，命中具有机会性；首段变化会使相同 key 失效。单元测试只能证明 key 生成规则，无法替代真实缓存回归。

## 6. 已确认的缺陷与 Gap

### 6.1 消耗控制

1. 用户群聊编排器单次约 5.3K Token，累计消耗与群聊主回复接近；mini 与 luna 合计占可计量总 Token 的 30.4%。
2. 群聊 Thread 分类在样本期几乎完全超时，仍持续发起请求并走降级，带来延迟和潜在未计量成本。
3. 一次记忆 batch 通常固定执行约 20.4K 的工作/长期记忆调用和约 9.5K 的用户画像调用，没有“本批没有新事件/稳定画像变化”时的廉价前置门控。
4. Tone 是所有非空外发文本的条件乘数，单次约 3.1K Token；短回复也携带完整人格与输出合同。
5. 主回复允许最多 20 个工具调用，没有 turn 级总请求数、输入 Token、输出 Token或预计费用预算。
6. 工具定义会完整进入主请求。真实样本中单次工具 JSON 可达约 16K 字符，工具描述和 schema 同时增加输入并扩大 cache identity。
7. Director 主动分享按目标会话 fan-out，每个目标重复完整 Agent、自画像、图片和 Tone 链路；缺少全局每日成本上限。
8. 节点普遍复用高达 2,400 的输出上限，Tone、编排器、Bash 审计等实际输出远低于上限，缺少按节点约束。

### 6.2 缓存控制

1. 群聊长期记忆进入 system，直接破坏首个 developer 前缀和 cache key。
2. 代码把“全部渲染后 system 文本”当作 static prefix，没有变量稳定性 provenance，也没有阻止 turn 级变量进入缓存前缀。
3. `gpt-5.4-mini` 会按 conversation 隔离 cache key；它在 3,381 个编排请求中只有 10 个首前缀，跨会话潜力很高，但当前机制不会主动复用稳定 key。
4. 工具定义、工具权限组合和 response schema 的任何变化都会生成新 key；系统没有工具/schema 变体预算或稳定 capability profile。
5. 当前只显示 cache read，丢失 `cache_write_tokens`。无法计算 GPT-5.6 官方 API 的净缓存经济性。
6. 没有 prefix digest、key 复用次数、首个变化字段、可缓存长度、cold/warm 标签和 key QPS，运营侧只能看到最终 cached=0。
7. Anthropic、Gemini 与 compatible Provider 没有主动缓存实现和 capability probe，跨 Provider 仪表盘会把“未实现控制”和“已实现但未命中”混在一起。

### 6.3 可观测性与归因

1. 行为桶过粗，多个独立节点落入 `other`。
2. 自拍改写继承父 stage；视觉 fallback 和 multimodal probe 没有独立 stage；无法从聚合直接分离。
3. Codex image generation 的日志顶层 model 是文本路由模型，真实 `gpt-image-2` 只在 metadata；图像调用会混入 reply/async 文本统计。
4. 失败请求缺少发送前 input 估算；无 usage 等同于未知，当前页面容易被理解为零。
5. memory 缺少完整 `runId`，物理尝试无法收敛为业务任务。
6. 逻辑调用、模型轮次和 transport attempt 没有统一父子关联；“一次回复花了多少”需要离线猜测。
7. 原始日志保存完整请求 payload。审计产物必须继续只输出聚合、长度和 digest，避免将会话或提示词正文复制到报告和指标库。

## 7. 可立即实施的代码改进

### P0：修复群聊稳定前缀

1. 将 `memory.long_term` 从群聊 system 移到现有的动态 developer 记忆块，位置应在稳定 system 之后、历史和当前输入之前。
2. 同步公共 source default、当前公共持久模板、所有 Agent override，并使用一次性保留式 prompt migration；已有管理员编辑必须保留。
3. 给 Prompt Catalog 变量增加 `static | agent | session | turn` 稳定性元数据。缓存前缀只允许 static/agent 变量；session/turn 变量进入时保存或渲染失败。
4. cache key 从“渲染后全部 system”升级为“稳定消息边界 + 模板版本 + 稳定变量 digest”。发送内容与 key 描述必须保持一致。
5. 回归覆盖公共模板、Agent override、热更新、迁移幂等、工具/schema 改变、记忆改变和跨 conversation key 复用。

预期验证：同一 Agent、模型、prompt family、工具和 schema 下，群聊 key 平均请求数明显高于当前 1.4–1.6；7 日群聊 API 缓存率从 7.3% 提升到至少 20% 作为首轮实验门槛。该目标需要 A/B 验证，不作为预先承诺。

### P0：修复统计模型

新增统一维度：

- `nodeId`：`reply.private`、`reply.group`、`orchestrator.user`、`orchestrator.thread`、`memory.merge`、`memory.profile`、`memory.dream`、`tone`、`director.plan`、`director.revise`、`air.read`、`selfie.rewrite`、`vision.describe`、`vision.probe`、`bash.audit`、`config.doctor`、`provider.probe`、`image.generate`、`emoji.generate`、`codex.deferred`。
- `logicalInvocationId`、`parentInvocationId`、`runId`、`round`、`transportAttempt`、`finalOutcome`。
- `cacheReadInput`、`cacheWriteInput`、`cacheReported`、`cacheEligible`、`cacheKeyDigest`、`prefixDigest`、`stablePrefixBytes`、`toolDigest`、`schemaDigest`。
- `predictedInput`：请求发送前的本地估算，只用于 Provider usage 缺失时展示区间，不能混入 Provider 实测总量。
- 图像与语音独立计量：image model、尺寸、质量、参考图数、图片数；TTS model、字符数、音频秒数。

SQLite schema 需要向前迁移。管理台同时展示“物理请求”和“逻辑业务调用”，缓存 read/write 分开，未知 usage 明确显示未知。

### P0：停止高失败率节点的无效放大

1. 群聊 Thread 分类：当前 5 秒预算与模型实际延迟不匹配。短期可在错误率熔断后停用模型分类并使用已有规则降级；后续改用更快模型、缩短输入或与用户群聊编排合并。单纯提高 timeout 会继续增加端到端延迟，需要同时限制输入和重试。
2. memory：为每个任务补齐稳定 `runId`，区分节点 timeout 和 transport timeout，超时后不要无界重做完整 snapshot；记录 snapshot digest，重试只在输入仍相同且预算允许时执行。
3. Director/Dream/selfie 的确定性 schema 400 立即失败，不进入周期性快速重试；同一 prompt/schema 版本产生确定性错误时按版本熔断，修复或版本变化后再恢复。
4. 所有节点增加逻辑预算：最大模型轮次、最大 transport attempts、最大累计输入、最大累计输出和截止时间。预算耗尽时返回稳定状态，避免继续调用后续高成本节点。

### P1：降低每个请求的输入

1. 用户群聊编排器：只保留判断所需的人格职责、最近窗口和结构字段，删除主回复才需要的表达、工具和媒体说明；将 P50 input 从约 5K 压到 2K–3K 作为实验目标。
2. Tone：保留语气所需的最小人格摘要和输出合同；把短文本气泡拆分改为宿主确定性规则，只有语气确需改写时调用模型；将 input 中位数降到 1K–1.5K。
3. memory：只发送变化批次、相关旧工作记忆和候选长期记忆；对没有新事件或稳定人物属性变化的 batch 先做本地门控。评估一次结构化抽取同时产出 event/profile，再由宿主分流，减少固定双调用。
4. 工具 schema：在权限校验前提下形成少量稳定 capability profile；移除重复描述和不可达工具，固定工具顺序。任何精简都不能扩大模型权限。
5. 按节点设置输出上限：编排器、Tone、Bash 审计、Config Doctor 使用远低于 2,400 的上限；Director、Dream 和 memory 根据 schema 真实 P90 设置。
6. 历史与上下文：记录每个 section 的 input 贡献，再按节点设置历史、记忆、工具和 schema 的独立预算；截断必须在语义边界完成并保留时间/引用关系。

若群聊回复 input 降低 20%、用户编排器降低 35%、两类 memory 降低 25%，按本样本构成估算可减少约 22% 的总 Token。该数值是结构性情景估算，需要通过离线 replay 和线上 A/B 验证质量。

### P1：建立 Provider 级缓存回归

1. 增加隔离 cache smoke：每个受支持 Provider/模型执行 cold + 至少 3 个 warm + 首段扰动，使用合成文本和独立 key。
2. 断言使用统计窗口：warm 请求中至少一次出现 cache read；不要要求第一次 warm 必然命中。
3. OpenAI 官方 GPT-5.6 单独验证显式 breakpoint、`cache_write_tokens` 和净成本；Codex 订阅后端单独验证隐式缓存。
4. Anthropic 和 Gemini 先做 capability contract，再实施 Provider 专属缓存字段与 usage；compatible Provider 只在探针确认后发送扩展字段。
5. 监控每个 key 的请求速率和前缀变体数，避免同一个 key 承载大量不同前缀。

## 8. 需要产品经理介入的流程决策

### 8.1 群聊双编排是否保留

当前可能依次执行 Thread 分类、是否回复编排、主回复和 Tone。Thread 分类几乎完全失败，用户编排器本身已经占总 Token 的 30.4%。需要选择：

- 用本地规则维护 thread，只保留是否回复模型；
- 合并为一次结构化编排，同时返回 thread 与 reply decision；
- 对低活跃群和明确 @ 场景跳过编排；
- 保留双节点，但设置每会话触发率、质量收益和成本上限。

决策需要离线 replay 评估误回复、漏回复、广播循环和 thread 准确率，不能只看 Token。

### 8.2 Tone 是否继续作为全量后处理

Tone 提供人格一致性和分段气泡，但每条文本会增加约 3.1K Token 和一次网络延迟。可评估：

- 主模型直接遵守语气，Tone 只处理错误回复、系统确认或风格置信度低的文本；
- 短文本使用宿主分段和规则修整，长文本才调用 Tone；
- 对主模型、场景和 Agent 做开关，而非全局同一策略。

A/B 指标应包含人格一致性、事实保持、XML 合法率、平均气泡数、延迟和每条外发 Token。

### 8.3 记忆是否需要固定双调用

每个 batch 成功样本约 30K Token，画像调用在没有新增稳定人物事实时仍可能执行。需要评估：

- 一次模型输出同时包含事件记忆和画像 delta；
- 本地规则先判定参与者和是否存在属性证据；
- 画像降低频率，事件记忆维持当前触发；
- Dream 承担低频整理，实时 pipeline 只保存轻量候选。

质量指标应覆盖错误画像、遗漏承诺、记忆重复、长期记忆晋升准确率和人工可编辑性。

### 8.4 主回复模型路由

`sol` 的请求级平均 total 和缓存率均弱于 `terra` 样本。模型样本对应不同 Agent 和场景，不能直接得出质量结论。需要按任务复杂度进行路由实验：日常群聊、工具任务、长文、管理员命令、图片理解分别比较 terra/sol/luna 的质量、延迟、工具成功率、总 Token 和缓存率。

### 8.5 Director 主动分享预算

主动分享按会话数线性 fan-out。产品需要定义每 Agent 每日分享数、目标会话活跃门槛、用户退订、图片比例和总预算；并允许在预算不足时减少分享目标，不能在运行时无限扩张完整自拍链路。

## 9. 建议实施顺序与验收

### 阶段 A：1–3 天

- 修复群聊长期记忆的动态边界并完成持久模板迁移。
- 增加 cache write、nodeId、logical invocation、prefix/tool/schema digest。
- 为 Thread 分类、memory、Director/Dream 增加失败熔断和完整 runId。
- 增加 cold/warm/mutated cache smoke。

验收：现有 Provider、prompt migration、reply、memory、Tone、Director 测试通过；新增 prefix 结构测试；真实合成 warm 至少一次命中；群聊模板中所有 turn 变量均位于稳定边界之后。

### 阶段 B：1–2 周

- 为编排器、Tone、memory 和工具 schema 建立 section 级 Token 预算。
- 管理台按节点展示请求级和业务级成本、P50/P90、cache read/write、失败未知量。
- 运行 7 日生产观测，比较群聊 key 复用、实际缓存率和延迟。

建议首轮门槛：群聊缓存率 ≥20%；Thread 分类错误率 <5%；memory 任务 runId 覆盖率 100%；无 usage 请求明确显示未知；cache write 可计量。

### 阶段 C：2–4 周

- A/B 群聊编排合并、Tone 条件调用、memory 单次抽取和模型路由。
- 用质量与成本联合门槛选择产品流程。
- 建立按 Agent、会话、节点和日预算的告警与熔断。

## 10. 验证记录

- `prompt-caching.test.ts`
- `openai-provider-async-codex.test.ts`
- `request-log-token-usage.test.ts`
- `token-usage-normalization.test.ts`

执行结果：4 个测试文件、42 个测试全部通过。

- `npm run check`：通过。
- `npm run architecture`：通过。

真实合成 cache smoke：`gpt-5.6-luna` cold/warm/warm/mutated 共 4 次请求；无 QQ I/O、无真实提示词和业务数据、未写生产 request logs，临时脚本已删除。

只读 SQLite：三套业务库均可读取，无锁冲突；未修改数据库、配置、提示词、服务状态或 outbox。

## 11. 主要代码与数据位置

- Provider 与工具循环：`adapters/model/provider/completion.ts`
- Cache key：`adapters/model/provider/promptCaching.ts`
- usage 归一化：`packages/contracts/model/tokenUsage.ts`
- 行为分类：`packages/contracts/model/modelCallStats.ts`
- 请求日志：`adapters/observability/requestLog.ts`
- 聚合写入：`adapters/sqlite/modelCallStore.ts`
- 主回复：`src/runtime/reply.ts`
- 群聊编排：`src/runtime/orchestration.ts`、`src/runtime/groupThreadPipeline.ts`
- memory：`src/runtime/memoryPipeline.ts`、`src/runtime/dreamPipeline.ts`
- Tone：`src/runtime/tone.ts`
- Director：`src/runtime/director.ts`
- AIR：`src/runtime/air.ts`
- 自拍：`src/runtime/selfie.ts`
- 当前群聊模板：`workspace/business/prompts/conversation_group_reply.json`
- Agent override：`workspace/business/agents/arona/system-prompts/conversation_group_reply.json`、`workspace/business/agents/koharu/system-prompts/conversation_group_reply.json`
