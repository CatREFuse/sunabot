# 验证标准与已知限制

[返回当前系统规范索引](./index.md)

## 11. 验证标准

交付前必须通过：

```bash
npm run verify
```

`verify` 依次执行 runtime contract、architecture、SQLite recovery、类型检查、单元与集成测试、独立 runtime smoke、CI 容量基线、生产构建和 E2E。消息专项回归必须证明 `assistant_text` 写入 durable outbox 后即可继续 inline 工具，远端发送仍在进行或重试时不能阻塞工具；事件重试不能重复发送已提交的中间消息。deferred `dispatch_message` 与任务必须原子持久化，worker 在 acknowledgement 仍待发送时即可 claim，callback 随后按同一会话 FIFO 投递。

回复防抖专项验收矩阵：

| 维度 | 必测场景 | 验收标准 |
| --- | --- | --- |
| 路由覆盖 | 私聊、群聊命令、明确 @、唤醒词和群聊 ambient 编排器肯定结果 | 所有入口使用同一条固定 5 秒尾随防抖链路；ambient 在编排器确认后开始计时；截止前不执行命令或调用主回复 Provider |
| 尾随重置 | 首条触发后，同一发送者在 5 秒内连续发送普通文本、图片、附件或引用消息 | 每条合法消息都把截止时间重置为其到达后的 5 秒；重复重置只产生一个真实回复事件和一次最终外发 |
| 首触发固定 | 后续消息包含新的命令、@ 或不同引用 | route、真实 current user 输入、幂等键和最终引用目标仍指向首条触发消息；后续消息只扩展上下文和截止时间 |
| 引用冻结 | 首触发时分别启用/关闭引用，等待期切换开关、命令排除名单或 group exclusion，并覆盖 Provider 运行中、SQLite reopen、deferred acknowledgement/callback 和 timeout/error | initial、命令、deferred 与错误外发都只使用首触发 `ReplyQuoteSnapshotV1`；on→off、off→on 与排除名单变化不能漂移引用；显式 none 也必须编码，当前 target 缺失或损坏 gate/quote 时失败关闭且不能读取热配置 |
| 命令冻结 | 首触发通过 mention alias 或 persona name 命中命令，等待期删除旧名、启用新名并分别重启；普通 direct 首触发后才启用可命中名称 | 命令按冻结 stable ID、args 和 rawText 恢复并只执行一次，不重新匹配热名称；direct 不晋升；未知 ID、缺失/错位 invocation、超限字段、原文不一致、额外可执行字段在 Provider 和 handler 前失败关闭 |
| 发送者隔离 | 同群发送者 A 重置自己的窗口，发送者 B 在 A 窗口内发言并独立触发回复 | B 不改变 A 的截止时间，A 也不阻塞 B；B 的消息仍进入 A 在释放边界内的上下文；两个候选分别按自身截止时间执行 |
| 多 Agent 隔离 | 相同 QQ 号或相同群号同时出现在不同 Agent、不同绑定账号的入站流 | synthetic Session、防抖事件、真实会话和 outbox 均保持 Agent 与 account ID 隔离，不能跨账号重置、引用或外发 |
| Provider 顺序与上下文边界 | 窗口内穿插同发送者与其他发送者的文本、图片、附件、引用和 Thread 消息，并在 handoff 后继续发言 | `messages_64` 截止到首触发以前；current batch 按 sequence 只包含一次首触发及全部窗口入站消息，真实 Provider 请求保持原顺序；图片继续受既有预算；Thread、附件和 deferred callback 共用 `contextThroughSequence`，handoff 后消息不追加入本轮 |
| 回复门控 | 等待期间关闭会话、scope 或全局回复，再在同一进程内重新开启 | 首触发快照在释放和真实回复前均被校验；旧候选结束为 `no_reply`，不会调用 Provider、创建回复 outbox 或在重新开启后复活 |
| 未来唤醒 | 创建防抖事件后没有任何新入站消息；另有更早或更晚的未来事件被重排 | Coordinator 始终按最早可 claim 的 `availableAt` 重置唤醒，达到截止时间后自动执行，不依赖新的 enqueue 或人工 resume |
| 重启恢复 | pending 防抖事件写入 SQLite 后停止并重建运行时；分别在 queue 首触发提交后、业务会话持久化前，以及 follow-up bump 提交后立即关闭 | 重启后按持久化的最新截止时间和有序入站快照恢复；同发送者或不同发送者继续发言时不会抢占 sequence；首触发、全部 follow-up、附件元数据、route、门控快照和引用目标保持不变 |
| 截止竞态 | 同一时刻运行中的源事件发生 deadline bump 与 handoff 竞争 | bump 先提交时旧 turn 回到新截止时间的 pending 且无目标事件；handoff 先提交时目标事件恰好一个，之后消息进入新窗口 |
| 原子 follow-up | 对 pending 与 running 候选分别在“追加 follow-up 快照”和“更新 deadline”之间注入故障，并重复投递相同 message ID | 两项更新同事务提交或同时回滚；重复消息不追加、不 bump；running 旧 handler 中断后重试读取新快照，多个文本、图片和附件 follow-up 顺序与元数据完整 |
| 无 message ID 幂等 | 完全相同消息重投，及同秒同文本但仅附件或引用不同的 A/B 消息，覆盖 encode→SQLite→decode、completed source reopen redelivery 与超过 64 条 tail | 所有路径复用同一 versioned canonical fingerprint；A/A 只记录和处理一次，A/B 保持两条有序记录；本地附件处理状态不改变身份，业务历史、记忆、Provider 与 durable duplicate validation 均无重复或误合并 |
| 跨发送者严格落盘 | conversation 有 active debounce 时，其他发送者入站的业务库单记录 upsert 分别失败/成功，并在成功后崩溃重启；后续包含待准备图片和附件 | 失败不 mark seen、不 bump deadline且可重投；成功后全局 sequence、附件准备和冻结 current batch 可从双 SQLite 恢复；常规保存与 outbox settle 在超过 top 80 时仍保护 active/source/callback/deferred 引用的会话记录 |
| 有界 durable tail | 同一发送者连续发送至少 65 条窗口 follow-up，最后一条含图片和附件，并在淘汰后立即崩溃、重启 | 首触发固定，durable `followUps` 始终不超过最近 64 条且当前消息必在 tail；业务会话与 Provider current batch 保持全部保留消息原顺序且不重复；tail 媒体元数据恢复；decoder 对第 65 条 durable follow-up 和畸形结构失败关闭 |
| 原子 handoff | 在源完成、截止校验或目标事件写入处注入 SQLite 故障并重试 | 源完成与目标写入同时提交或同时回滚；没有部分 handoff、重复真实事件、跳号 turn 或重复 outbox |
| handoff provenance | 预先写入与目标使用同 session/dedupe key 但 kind、sender、message、gate、quote、context、correlation 或 causation 不同的事件，并覆盖相同 payload 重试与 crash retry | 只有 canonical envelope 完全一致的目标可幂等复用；collision 整体失败关闭、source 保持可恢复且不能完成或吞回复；普通 enqueue 去重行为不改变 |

`system_config` 专项回归必须覆盖管理员 QQ 私聊授权、普通私聊/群聊/prompt override 拒绝、Web Chat 查询保留与修改失败关闭、严格 schema 非法输入、未知群聊、Tavily 单一实现、Bash 偏好与 capability 分离、密钥/路径/消息/诊断脱敏，以及 OpenAI Responses、Codex Responses、Chat Completions、Anthropic、Gemini 五条 Provider 工具循环的整 turn 独占规则。已知群聊查询还必须覆盖 250 个以上静态群聊按完整 conversation ID 分页无重复无遗漏、账号限定 ID 原样往返、`groupLimit` 的 1—100 边界和默认 50、合法未知游标继续、畸形游标失败关闭、当前 Agent 隔离、私聊与非法记录排除、安全字段投影，以及 Web Chat/管理员私聊查询零 staged mutation；`set_group_reply` 继续覆盖分页范围外的任意真实完整 ID。

held confirmation 测试必须覆盖 schema 4→5 与旧行 `none` 迁移、append 单事务直接插 held、ordinary/held 共用 event ordinal、ordinal 或 fingerprint 冲突失败关闭，以及 held 同时阻塞所属 session 和 delivery partition 而不阻塞其他 partition。append 未调用、append 失败、空正文、`before_reply` 中止和 gate race 均不得提交；append 成功后才 commit，commit 成功后才 release；远端离线不撤销配置且确认继续重试；commit 失败原子转中性通知，neutralize 事务任一点失败保持原成功文案 held 且不可 claim；release 响应丢失与同值重试幂等，改变 fingerprint 或 gate 的重试拒绝。fingerprint 需覆盖 Agent、完整会话、当前管理员、action、规范化参数和关闭私聊门控标志，并验证同事件相同值可恢复、不同值拒绝且不含密钥。

held gate 回归必须证明同 generation 下普通确认只接受 epoch 不变，关闭当前私聊自动回复只接受 private scope epoch 恰好增加 1 且 conversation epoch 不变；额外 scope/conversation epoch、account、sender、group、图片、多工具或非当前管理员均拒绝。跨 generation fallback 与旧 released 确认只允许新 runtime 当前 private scope/conversation epoch 为 0/0；非 0/0 保持 held 或拒绝投递。startup recovery、正常 finish、fail 与 defer 都必须把遗留 held 安全转为 `fallback_released`、调度 outbox 并终结 origin turn/head event，released 但未 finish 的 origin 不能再次执行 Provider 或 commit。构造期 `recoverOnOpen` 必须覆盖“缺 resolver 原子失败”和“提供 resolver 后单次启动直接 fallback、终结 origin、可投递且第二次恢复为零变更”；成功 immediate confirmation 必须同时断言 outbox 为可信 released、turn/result 统计为 `replied`，不能记为 `no_reply` 或因关闭当前私聊门控记为失败；release 已持久化但响应丢失时同样由 canonical released 行收敛为 `replied` 且不重复提交或投递。`delivery_unknown` replay 必须保留可信 released/fallback lineage 与 mutation fingerprint；普通 marker/`hold_state=none`、held 未释放、伪造 replay key、跨 session 冲突、源 payload/partition/provenance 漂移和 8 层 lineage 篡改均不得升格或投递，第 9 层明确拒绝。marker decoder 还需覆盖旧 payload、唯一合法字面量和非法值拒绝；后续普通回复继续受新门控限制。

群聊 Thread 专项回归必须证明原始消息数组保持同一引用、顺序和数量，群聊元数据字段完整、结构字符可逆转义且私聊格式不变；正文中的提示词变量 token 必须按原文保留。引用规则、批内引用链、外发回执 ID、派发时固化且不随配置漂移的实际引用目标、模型歧义分支、完整批次上下文与目标 ID、临时 key 到稳定 ID、模型选择的 active Thread、完整句 topic、低置信度、非法输出、提交失败回退持久态和分类失败回退均有覆盖。积压恢复必须覆盖 129 条消息按 64 条分批追平，动态 sidecar 只索引真实 `messages_64`，自定义旧内容被替换和重新定位且相邻规则不丢失，模型 topic 不能闭合 developer 标签；真实 user 正文中的同名标签必须原样保留，旧占位只能收到空兼容值，只有旧契约的 system 消息也要恢复当前契约。自定义模板使用 `conversation.messages`、重复展开历史或把当前 user 放在历史之前时，必须保持每份历史内部顺序并恢复正确的当前消息位置；群聊模板在不提供动态 Thread 变量时仍须先完成渲染，再由运行时插入合法空 sidecar。提示词容量回归必须覆盖 Thread、参与者、消息 ID 和 assignment 的确定性上限、active Thread 保留、引用完整性及省略计数。SQLite 测试必须覆盖 schema 9→10、STRICT/外键、完整状态校验、revision CAS、sequence 防回退和 run key 幂等；恢复门禁还要覆盖 schema 9 旧 current 恢复点、伪造版本拒绝与 schema 10 缺表拒绝。持久化 contract 必须覆盖合法有界 Thread 快照在 deferred 原始请求和 assistant outbox 中往返、旧记录无字段兼容、非法引用、非法 sequence 或超限快照降级、异步回调复用原 capture sequence，旧回调缺少快照时不得读取最新 Thread 状态。设置页必须覆盖旧公共配置和旧 Agent manifest 的默认值、配置自检补齐并实际应用字段、独立模型保存、空值拒绝、主动编排器关闭时仍可编辑，以及桌面/移动端 light/dark 截图。

涉及界面时还要运行视觉测试并检查截图；正常回复重试必须覆盖默认 3 次、0—10 配置校验、公共分区热更新、SDK 与原生 HTTP Provider 的相同请求重试、取消后停止、请求日志尝试序号，以及 light/dark 和移动端设置页。Web Chat 必须覆盖管理员身份、每 Agent 顺序执行、连续消息 ID、目标 Agent 日志与 Token 选库、Web/QQ 外发隔离、消息轮询、发送校验、键盘操作、图片缩略图和移动端布局。多 Agent 测试必须覆盖 Agent 原子创建与运行时失败补偿、路径校验、独立 SQLite 与队列、独立人格、公共系统提示词继承、Agent 系统提示词覆盖、QQ 唯一归属、WebUI 端口唯一性、primary 不可移除、同一 OneBot listener 的多账号并发连接、重启恢复、secondary 账号引用与身份查询、primary 兼容接口定向 action、Agent 级和全部 Agent Token 汇总。广播风暴测试必须覆盖同一 Agent 不计数、同群所有不同 Agent 对共同累计、不同群分开计数、补充嗅探账号、重复 OneBot 事件去重、m 窗口淘汰、n 阈值触发、k 静默期、静默期不创建新任务、已 dispatch 任务与 outbox 不受影响、静默期消息只记录、自动恢复、关闭功能与配置热更新。涉及数据迁移时必须核对默认与显式配置 API 直启的写入前零变更门禁、fresh-install 与 completed-migration 标记、首次 marker 发布中断、主库出现后的半初始化拒绝、标记篡改、全部注册 Agent/账号状态漂移、目标 workspace 与端口漂移、必需路径符号链接穿越、外部数据库覆盖、secondary 账号监听、全部账号端口、带标签的各种活动容器、迁移报告四类 copied/preserved 证据、SQLite 表记录数、公共系统提示词哈希、旧文件备份和服务重启后的 API 与 OneBot 状态。Linux 发行验收还要核对干净源码门禁与重新生产构建，预构建 Native Core、生产依赖、Docker Core 构建上下文、迁移 wrapper、门禁模块和迁移文档均存在；在无 `.git`、无开发依赖的解包目录复验真实平台、runtime contract、完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件的文件集合及哈希后完成 dry-run，并用篡改 fixture 证明失败关闭。

配置医生验收必须限定目标为 `workspace/business/config/sunabot.json`，覆盖缺失 `schemaVersion` 或小型设置的本地补齐、不支持版本拒绝、UTF-8 BOM 与末尾逗号修复、无效 UTF-8/NUL/重复字段/超限文件/超深或过度复杂结构/非法 JSON/非法根结构的手动处理，以及 Agent manifest、提示词、凭据、SQLite 和其他文件零修改。API 测试必须覆盖 `GET /api/config-doctor/scan`、`POST /api/config-doctor/propose` 和 `POST /api/config-doctor/apply` 的封闭响应 schema、鉴权、session CSRF 与 Origin、错误映射、10 分钟 proposal 过期、10 秒 AI 限流和源 revision 冲突。AI 测试必须证明每次建议只有一次无工具模型调用、请求经过脱敏、异常字段名不外发、响应为受限结构化 JSON，并拒绝过大输出、超过数量或深度限制的操作、非法 JSON Pointer、原型污染字段、重复路径、`remove`、白名单外路径和非当前问题路径。应用测试必须覆盖共用写互斥锁、完整候选校验、运行时预检、持久备份、备份父链与配置文件符号链接拒绝、原子写入、写入前后 revision 复验、热更新、方案外磁盘配置保持待加载，以及预检失败、并发修改、运行时提交失败和双重恢复失败的故障注入；不把备份目录视为用户主动回滚功能。管理台还必须检查独立 `/config-doctor` 页面在系统设置下方的导航位置、状态、AI Provider 信息、服务端目标值说明、修复确认、过期方案、重启提示和成功备份路径，并完成桌面与移动端 light/dark 视觉检查。`./sunabot.sh doctor` 的只读行为必须保持不变，不能把当前版本描述为具备 CLI 离线修复。

Token 统计验收必须覆盖 OpenAI Responses、Deferred Codex CLI 成功与失败结果、Chat Completions、Anthropic 和 Gemini 的原始 usage 夹具，验证缓存输入不重复计数、Codex CLI 失败 usage 不丢失、Anthropic 三类输入求和、思考 Token 归入输出、缓存率分母只包含明确报告缓存字段的记录、无缓存字段返回 `null`、显式零缓存返回 `0`、时区跨日、24 个小时桶、最近 53 周日期范围，以及模型与功能组合筛选不改变可选模型集合。行为统计必须验证回答、编排器、记忆总量与两类真实记忆拆分无重复计数，并验证 `conversationId` 精确隔离。管理台测试必须验证小时/日切换、模型/功能筛选、371 个日历单元、24 个小时柱、缓存率折线不产生 `NaN`/`Infinity`，并分别检查移动端与桌面端的 light/dark Token 卡片、行为统计、群聊详情、日历、小时图和展开后的结构化 usage 日志截图。

Prompt Cache 验收必须分别执行 OpenAI 官方 Responses 与 Codex Responses 的两轮真实连续对话：两轮使用同一模型、提示词家族和稳定 system/developer 前缀，第二轮追加第一轮用户消息与助手回复；逐轮记录 Provider 实际返回的原始 `input_tokens`、`cached_tokens` 和可用的 `cache_write_tokens`。OpenAI 官方 GPT-5.6 及后续支持显式断点的暖请求必须命中前导稳定前缀；Codex GPT-5.6 及后续请求必须以首个 developer input 承载合并 system 文本，不发送 `instructions`、`prompt_cache_breakpoint` 或 `prompt_cache_options`，并如实记录后端机会性隐式缓存结果，不能把未报告的缓存写入或偶发命中推算成稳定缓存率。旧模型、未知模型和兼容 Provider 请求体不得出现显式断点字段。测试还必须验证 system/developer 前缀、完整工具定义或输出 schema 变化会切换缓存键，动态历史、记忆和当前输入变化不会改变稳定前缀键；协议映射前后的语义内容、非 system 输入顺序、图片、工具和输出 schema 必须一致。

涉及跨平台运行时还要执行 `./sunabot.sh doctor`，分别验证 Native Core + 多 NapCat Docker 与 Docker Core + 多 NapCat Docker 的启动、停止、单实例、管理台单账号“运行”、OneBot token、两个 QQ 同时在线、文字、图片、文件、账号定向外发和重启恢复。contract 与测试必须拒绝 NapCat 并入 Core、多个账号复用同一 WebUI 端口、OneBot 复用管理端口、跨组件共享绝对路径和旧新运行时并行。

## 12. 已知验收限制

`FLOW-001`、`FLOW-002`、`FLOW-003`、`MIG-001`、`MIG-002`、`RECOVERY-001` 与 `ONBOARD-002` 至 `ONBOARD-005` 的代码、故障注入和受控 E2E 已完成。真实 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 的双 QQ 首次运行、账号定向文字/图片/文件外发和重启恢复仍需在具备两套运行环境与真实 QQ 登录态时执行；在该验收完成前，不能把受控 Provider/OneBot fixture 视为真实部署证据。
