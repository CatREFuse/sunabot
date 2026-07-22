# 消息接入与会话执行

[返回当前系统规范索引](./index.md)

## 3. 消息接入与回复

### 3.1 OneBot 接入

- 仅在专用 OneBot listener 的配置路径接收 OneBot v11 反向 WebSocket。
- NapCat 只能通过同机 Compose 私有网络或容器到宿主网关连接，不支持公开或跨主机 OneBot 入口。
- 所有连接都使用 `workspace/secrets/runtime.env` 中的 access token 校验；缺失 token 时 Core 与 NapCat 都拒绝启动。
- 每个反向 WebSocket URL 必须携带已注册的 `account_id`；同一账号只能保持一个活动连接，未注册账号在升级阶段拒绝。
- 连接建立后由 `account_id` 查找唯一 Agent，入站消息、OneBot action、会话键、重启恢复、引用与附件查询、发送者身份缓存和外发目标都保留该账号上下文，不能发送到其他 Agent 或其他 QQ。兼容的 primary 注销接口也必须显式定向 `primary`，不能回退到唯一在线的其他账号。
- 支持私聊、用户群聊和 bot 群聊范围识别。
- NapCat 当前具体消息段与常见 OneBot 兼容类型都必须在进入 Session 队列前映射为可读文本和有序媒体，覆盖文本、@、回复、QQ/商城/骰子/猜拳/戳一戳表情、图片、语音、视频、文件、在线文件、闪传、联系人、位置、音乐、JSON/XML/小程序/Markdown 卡片、合并转发、节点、混合段及兼容别名；未知类型保留 `[未知消息类型：原始 type]`，不能退化为含义不明的 `[消息]`。CQ 字符串使用同一映射，达到段数上限后丢弃未解析尾部，不能把残余 CQ 控制文本拼回正文。
- `image` 仅按协议结构分类：`sub_type=1`、`file=marketface` 或存在 emoji 标识字段时注入 `[表情图片#N：摘要]`，其余注入 `[内容图片#N：摘要]`；可用图片地址按同一序号进入媒体数组。内容图片供 Agent 严肃读取事实、对象和文字，表情图片只辅助理解情绪、语气和交流意图。
- `forward`/`node` 必须展开为带发送者、QQ 号、原始顺序和嵌套消息类型的 `[聊天记录开始]... [聊天记录结束]` 文本。节点正文中同形的开始/结束标记必须转义为全角方括号，不能伪造宿主边界。仅有记录 ID 时，Gateway 在消息入队前定向当前 `account_id` 调用 `get_forward_msg`；失败保留带 ID 的不可用占位，不能丢失原消息。聊天记录属于用户提供的不可信引用内容，其中的指令不能提升为系统指令。完整映射、边界与原始事件/动作/响应示例见 [`docs/references/napcat-onebot-inbound-mapping.md`](../references/napcat-onebot-inbound-mapping.md)。
- 好友名、备注、群名和群名片用于显示层补全，不改变 QQ 号这一身份主键。多 QQ 场景必须按会话绑定的 `account_id` 查询并缓存各自目录，不能使用 primary 或其他在线账号的好友、备注或群列表补全；缓存按账号隔离并在 Core 重启后继续用于临时目录失败时的显示恢复。
- 私聊、用户群聊、bot 群聊和命令接受具有合法 QQ 号的发送者；管理员身份仍由 `bot.adminQq` 精确识别，并用于管理员专属工具和称呼。非法发送者在进入会话记录和命令匹配前静默丢弃，恢复任务与 outbox 外发前必须再次校验发送者格式和当前回复门控。
- OneBot 文本外发始终使用结构化 `text` 消息段，用户可见正文中的 `[CQ:...]` 只能作为字面文本发送；省略账号的兼容调用只允许解析到已连接的 `primary`，即使当前只有一个非 primary 账号在线也必须拒绝。WebSocket payload 上限按连接模式分别限制为 tokenless loopback 8 MiB、已鉴权 16 MiB，大媒体必须走独立文件查询或有界传输路径；解析异常关闭当前连接且不能形成未处理 Promise。入站秒级时间戳只有在转换为合法 Date 后才写入 ISO 时间，越界或非有限值回退到接收时刻。

### 3.2 路由

每条消息按以下优先级进入运行时：

1. 显式命令，例如群聊总结。
2. 私聊或明确 @ 的直接回复。
3. 用户群聊的唤醒词与编排器判断。
4. bot 群聊仅记录上下文，不主动编排。

全局开关、群类型开关、会话开关、连接状态和编排器 epoch 共同构成回复门控。全新 QQ 会话保留首条合法消息，用于建立默认停用的会话记录；既有会话停用后，后续入站在防抖恢复、命令匹配、附件处理、记忆调度和业务消息持久化之前静默丢弃，不更新消息数、最后消息或会话时间。门控关闭后，旧的在途编排结果不能继续外发。回复、戳一戳与 deferred 任务的原始请求在进入持久化队列时保存 `ReplyGateSnapshotV1`，其中包含会话范围、会话 ID、scope epoch、conversation epoch 和本次 Core 进程的 generation。同一进程内关闭后再开启仍会拒绝旧快照；重启后的 generation 变化和旧版无快照记录都按当前开关重新校验，避免进程内旧任务复活，同时保留升级与重启恢复能力。

用户群聊编排器的 payload 必须在 `conversation.recentMessages` 和 `currentMessage.text` 中保留每张真实图片的语义标记。OneBot 新入站优先使用 `[内容图片#N：摘要]` 或 `[表情图片#N：摘要]`；旧消息缺少语义标记时才按缺少数量补充 `[图片]`。已有语义标记和旧 `[图片]` 都计入图片数量，不能重复注入。图片媒体仍与正文分离保存，编排器继续接收 `imageCount` 和历史媒体句柄用于判断，不直接接收图片 URL、Data URL 或本地路径。

用户群聊编排器的结构化输出只接受未包裹的单个 JSON object，字段集合必须精确为 `should_reply`、`reason`、`reply_to_message_id`：`should_reply` 是 boolean，`reason` 是合法 string，肯定结果的 `reply_to_message_id` 只能是本批 `conversation.replyCandidateMessageIds` 中的 string，否定结果必须显式为 `null`。别名、缺失或额外字段、数值 ID、类型异常、Markdown code fence、说明文字或其他文本包裹全部失败关闭，不得创建回复任务。肯定结果以有界 `UserGroupOrchestratorResultV1` 随 ambient 防抖、真实回复事件和 deferred 原始请求持久传递，重启、尾随消息和异步回调不能改写原因或目标 ID；直接回复、命令和其他非编排器路径不携带该结果。

用户群聊编排器按会话自动管理激活期。新会话沿用默认开启状态；编排器返回有效的 `should_reply=true` 后继续保持开启，返回第一条有效的 `should_reply=false` 后立即关闭该会话编排器并持久化状态，后续普通群消息不再创建 ambient 判断。全局编排器开启时，显式唤醒词、明确 @ 或命令会自动重新打开对应会话的编排器，本次直接回复或命令消息同时作为已消费边界，后续普通群消息再进入新的编排批次。超时、取消、Provider 失败或结构化输出无效不视为“不回复”，不能关闭编排器。自动开关只影响当前会话，其他群聊状态不变；Core 重启或 OneBot 重连后只恢复仍处于开启状态的会话，已经自动关闭的会话保持关闭，直到再次被显式唤醒或手动开启。

广播风暴嗅探是系统级新任务门控。受监控账号包含所有已启用 Agent 绑定的已启用 QQ，以及公共配置中的补充嗅探 QQ；同一 Agent 绑定的多个 QQ 视为同一参与者，每个补充 QQ 视为一个参与者。开启后，同一群内任意两个不同受监控参与者发生显式引用回复时记一次，同一条消息经多个 NapCat 连接重复到达只计一次；同群内不同 Agent 对之间的次数共同累计，不同群分别计数。在配置的 m 分钟窗口内累计 n 次后触发风暴，k 分钟内所有 Agent 对新收到的私聊、群聊、命令和 Web Chat 消息只记录而不创建回复任务。触发前已经 dispatch 的直接回复、群聊编排、deferred tool completion、`no_reply` 戳一戳和 outbox 继续执行与投递，不取消、不失效。静默期结束后恢复为新消息创建任务，静默期内收到的消息不得延迟补建任务。默认开启，m=2、n=3、k=1，补充嗅探账号默认为空；开关、m/n/k 与补充账号名单在系统设置中热更新并保存到公共配置。

### 3.3 按发送者回复防抖

私聊以及群聊中的命令、明确 @ 和唤醒词等主动唤醒统一执行尾随防抖；群聊 ambient 编排器没有防抖缓冲，肯定结果直接进入真实会话队列。防抖时间由各 Agent 的 `bot.replyDebounceMs` 独立配置，默认 5,000 ms，允许 1,000—60,000 ms，并在 Agent 设置的“回复行为”中以 1—60 秒编辑。防抖键按 Agent 运行时、QQ 账号、会话和发送者隔离；首条满足私聊或群聊主动唤醒条件的消息创建回复候选，但在当前静默期结束前不得进入命令执行或主回复流程。同一发送者在窗口内到达的任意后续合法消息都会按该 Agent 当时生效的防抖时间重置候选截止时间，无论后续消息本身是否满足触发条件；其他发送者的消息不改变该截止时间。不同发送者、不同 QQ 账号和不同 Agent 的候选各自计时，不能互相阻塞或重置。

首条触发消息固定本轮 route、幂等键和最终引用目标，窗口内后续消息不能替换这些字段。触发时把当时已经生效的引用开关、排除规则结果和首条 message ID 编码为必填的 `ReplyQuoteSnapshotV1`；防抖 handoff、主回复、命令投递、deferred acknowledgement/callback 和 timeout/error outbox 只消费该快照，窗口内或重启后的引用配置热更新不能重新计算引用。命令 route 同时保存只含稳定命令 ID、调用名、参数和原始文本的有界 `CommandInvocationV1`，执行时按 ID 恢复当前静态定义，不能重新使用热 mention/persona 名称匹配；未知 ID、超限字段、原始文本不一致或任何可执行字段都失败关闭，普通 route 不能携带 invocation，也不能在等待期间因新名称启用而晋升为命令。

`messages_64` 只读取首条触发以前的历史；首条触发至防抖释放边界内已持久化、且发送者与首条主动唤醒者相同的消息按 conversation sequence 合并成 current batch，因此 Provider 看到的顺序始终是历史、首条触发、同一发送者的窗口后续消息，首条触发不会重复。其他发送者在窗口内的消息继续按原顺序保存到群聊原始记录，并可供其后续回复或编排器批次使用，但不得进入本轮 current batch、附件、图片、自拍参考、图片工具媒体句柄或 Thread 增量上下文，也不得阻塞本轮等待；群聊 Thread 快照冻结在主动唤醒的首条触发边界。释放后才到达的消息进入后续窗口，不能追加入已经 handoff 的回复。deferred 工具回调继续携带首条触发消息、派发时的 `contextThroughSequence`、Thread 快照、门控和引用快照，并复用相同的有序同发送者 current batch，不在任务完成时重新扩展上下文。当前 schema 的 `reply_debounce` 与 `incoming_reply` 缺少或损坏门控、引用快照时必须失败关闭；只有明确版本化的旧记录可以走兼容读取，兼容路径也不能从当前热配置补写冻结决策。

私聊、群聊命令与主动直接回复使用同一条持久化防抖链路；群聊 ambient 候选在编排器确认应回复后直接创建 `incoming_reply`，不创建 synthetic `reply_debounce`，同时继续持久传递结构化编排结果、门控和引用快照。首条主动触发时捕获 `ReplyGateSnapshotV1`，防抖释放和真实回复执行前都重新校验发送者、会话开关、scope/conversation epoch 与 generation；等待期间关闭门控会取消旧候选，同一进程内重新开启不能恢复该候选。广播风暴只阻止静默期内新建候选，已经进入防抖链路的候选继续遵守既有已 dispatch 任务语义。

### 3.4 群聊上下文梳理

群聊回复在记忆召回和主回复模型之前运行 Thread 前置节点。该节点只生成附加索引，不删除、替换、截断或重排会话消息；`messages_64` 继续按原始时间顺序注入，消息正文中的 `@{...}` 等文本按不透明数据原样传递，原始消息始终是主回复模型的事实依据。私聊消息格式保持不变；群聊消息正文前使用完整字段名记录 `timestamp`、`sequence`、`message_id`、`display_name`、`uid` 和可选的 `reply_to_message_id`。元数据中的百分号、竖线、方括号和换行使用可逆百分号转义，正文保持原样，群名片不能伪造 uid 或引用字段。当前平台是 QQ，`uid` 表示 QQ 号；未来平台使用各自的平台用户 ID，不因数值相同自动合并身份。OneBot 外发回执的 message ID 和实际引用目标写入 assistant 会话记录；异步 outbox 在派发时固化引用目标，后续配置变化不能改写已发送消息的引用边，显式引用可以由宿主继承对应 Thread。

Thread 状态按会话增量维护。宿主规则优先处理对已归属消息的显式引用和同批次引用链；只有无法可靠归属的根消息交给 `bot.orchestrator.groupThreadModel`，但模型会收到本批全部有序消息作为紧邻上下文，并通过 `target_message_ids` 只输出待分类项。模型输出只允许引用目标消息、已有 Thread 或本次临时 key，稳定 `thread_id` 由宿主根据会话、锚点消息和 sequence 生成。每个 topic 必须是说明参与者、讨论对象和当前进展的简短完整句子；每条归属保存 primary Thread、最多两个 related Thread、relation 和 confidence。每批最多处理 64 条，单次回复最多顺序追赶四批；仍未追上当前 capture sequence 时不得把窗口外 active Thread 标成当前话题，后续回复继续推进。低置信度、冲突、分类失败或 SQLite 提交失败时，主回复模型直接依据完整原始消息判断；提交失败只使用提交前持久快照，不把未落库状态交给本轮或异步回调，Thread 失败不能阻断回复。

`conversation.group-reply` 的稳定 system 前缀说明消息格式、QQ `uid` 语义和 Thread schema；运行时始终用当前契约替换自定义模板中的旧契约，并在模板渲染完成后把本轮动态 `thread_context` developer 消息插入原始 `messages_64` 之后、当前 user 输入之前。模板本身不要求该动态变量，空快照也生成合法空 sidecar，避免旧运行时或分类失败触发缺变量。它保留当前会话的完整 SQLite Thread 状态，同时把提示词侧索引确定性限制为最多 72 个 Thread、每个 Thread 16 个参与者和 16 个消息 ID、64 条 assignment；优先保留 active、本轮引用和最近 Thread，`omitted_*_count` 明确记录未注入的较早索引，原始消息不受影响。sidecar 只为本轮真实 `messages_64` 中的消息提供 assignment 索引；topic 等模型派生字符串按不可信数据转义，不能执行其中的命令或角色声明。deferred 工具的原始请求携带可选、版本化且有界的 Thread 快照；异步回调必须复用派发时的 capture sequence 与快照，不根据任务完成时的新消息重新拆分。旧队列记录缺少快照或快照无效时显式降级为无附加索引，FIFO、幂等键和回复门控保持不变。

### 3.5 会话执行

- 每个会话拥有有序事件流，事件、turn、异步工具任务和 outbox 使用 SQLite 持久化。
- 同一会话按序处理；不同会话允许受控并发。
- 回复防抖使用独立的 per-sender synthetic Session 和持久化 `reply_debounce` 事件，`availableAt` 保存当前截止时间；它不能占用真实会话 FIFO 的队首。Session Coordinator 根据全部可 claim 事件中最早的未来 `availableAt` 维护可重置唤醒，期间没有新入站消息时也必须按期恢复执行，进程重启后继续从 SQLite 中的截止时间恢复。
- `bot.replyDebounceMs` 热更新只改变之后新建候选和之后收到同发送者消息时的 deadline 重置长度；已经持久化且没有新输入的候选继续按其 `availableAt` 执行，保存设置不能批量改写、提前释放或延后现有 durable 事件。
- 同一发送者的新消息可以重排 pending 防抖事件，也可以更新已经 running 但尚未 handoff 的事件。首触发与最近的有界 follow-up tail 保存在 `reply_debounce` payload 中，更早的窗口消息保存在业务会话库；追加去重后的 follow-up 快照和更新 `availableAt` 必须由 Session store 在同一事务、同一比较更新中提交，不能依赖当前消息已经写入业务会话数据库。重启恢复或分配新 conversation sequence 前，运行时先按 message ID 幂等物化该会话内的 durable 防抖快照，避免 queue 已提交而业务会话尚未落盘时，同发送者或不同发送者的新消息抢占首条 sequence。重复投递同一 message ID 既不追加快照，也不延长截止时间。
- 缺少 transport message ID 的入站消息使用统一、版本化且定长的 canonical fingerprint 作为 Session 去重键、准备键、durable snapshot 身份和业务会话记录 ID。指纹覆盖 Agent/account/self、conversation、sender、时间、文本、媒体、附件稳定元数据、reply message IDs 和 quote references，忽略本地缓存路径与解析状态；完全相同的重投保持同一身份，仅附件或引用不同的消息必须保持不同。completed source 在重启后再次投递时由已完成的 Session 去重结果直接阻止重复业务记录、记忆入队和 Provider 调用。
- 只要 conversation 中存在 active 防抖，任何发送者的当前入站都必须先通过严格的单记录业务库 upsert 再进入 seen/sequence 后续步骤；SQLite 写入失败时不得吞错、标记 seen 或延长任一发送者的 deadline，重投后仍可恢复。active debounce、已 handoff 且带冻结边界的 source、deferred callback 与 queued/running deferred job 所引用的会话记录属于持久化保护集；常规批量保存和 outbox settle 的 top-N 投影都不得删除这些记录，直到对应任务终态后才可释放。
- `reply_debounce.followUps` 最多保留最近 64 条，首触发始终单独保留。每次追加前必须先把当前 active payload 中的全部快照幂等写入业务会话库，随后才能在原子 deadline/payload CAS 中淘汰最老 follow-up 并纳入当前消息；因此持续发送不会让单个 Session payload 或 decoder 工作量无限增长，当前消息也不会静默丢失。decoder 对超过 64 条或结构非法的 durable payload 失败关闭。重启时已落盘的较早消息与最近 64 条 durable tail 共同恢复完整的保留窗口；如果业务会话记录缺失了已经从 payload 淘汰的 sequence，运行时必须失败关闭，不能把 tail 压缩成错误顺序。
- 防抖 turn 完成时在同一 SQLite 事务中校验预期截止时间、完成 synthetic 源事件并向真实会话写入 `incoming_reply` 目标事件；截止时间更新先提交时，已经读取旧 payload 的 running turn 因预期截止时间不符而中断，重试读取含 follow-up 的新 payload 并按新截止时间执行，不能留下目标事件；handoff 先提交时，随后到达的消息进入新的窗口。事务失败必须同时回滚源完成和目标写入，重试只能产生一个真实回复事件。若目标 session 已存在相同 dedupe key，handoff 专用路径必须逐字段核对 kind、payload、correlation/causation 和幂等来源的 canonical provenance；完全一致才视为幂等重试，任何 collision 都回滚整个事务并让 source 保持可恢复，普通 enqueue 的兼容去重语义不受影响。
- 外发使用 outbox，支持租约、有限重试、断线恢复和幂等键。OneBot outbox 按 account ID 持久化投递分区；离线分区暂停时，其他账号继续按各自 FIFO 投递，探针和恢复只作用于目标分区。
- outbox、turn 与工具任务的租约续期异常必须中止当前 claim，并通过稳定错误码与记录 ID 暴露持久化降级状态；outbox 失败终态只有在 `finishOutbox` 成功提交后才能标记 finalized。终态写入失败时保留可恢复 lease、延后重新扫描，不能吞错或在同一 claim 内重复终结。
- OneBot 发送和本地 settle 使用持久化两阶段。远端成功后先记录 receipt 并进入 `sent_remote`，会话投影、请求日志、记忆入队和逐 handler `after_reply` 使用稳定 settle key 继续执行；任何不确定传输或 hook 副作用进入 `delivery_unknown`，只接受人工 `applied` 或 `not_applied` 确认，不能自动重复外发。旧 schema 中无法判断远端结果的 `sending` 记录迁移为 `delivery_unknown`，并安全推进连续终态 cursor。
- 当前 Agent 启用 `bot.tone.enabled` 后，所有将发往 OneBot 的非空文本在可用的 `before_reply` hook 之后、写入 durable outbox 或直接调用 OneBot 之前统一进入 tone 节点。覆盖普通最终正文、`assistant_text`、deferred `dispatch_message`、异步 callback、timeout/cancel、错误回复、服务上线通知和 `system_config` 确认；纯媒体回复不调用 tone。默认 `bot.tone.segmentedReply=false`，节点只替换文本，生成图片、媒体引用、附件、文件、引用快照、Agent/account、会话、幂等键、消息来源和工具 trace 均保持原值。开启分段回复后，Tone 输入作为不透明正文原样传递，其中已有的待订正 XML、嵌套或未知标签在进入 Tone 前不解析、不拒绝；Tone 提示词负责按同一输出合同检查和订正，宿主只在 Tone 返回后执行严格解析。返回结果只接受平铺在顶层且绝不嵌套的 `dialogc`、`dialog`、`exp`、`img`、`voice` 与 `file` XML，`br`、HTML 和其他任何标签均非法；每个节点转换为一个有序消息气泡，只有第一条 outbox 保留引用和结构化 @。同一回复产生多个气泡时，每条 durable payload 固化自己的批内序号；第一条出栈后立即发送，后续每条在完成 claim、开始远端传输前分别随机等待 500—2,000ms，等待可由协调器取消且取消时不能标记 transport started。单气泡、旧 payload、非 outbox 直发和 settle-only 恢复不等待。`dialogc` 仅允许作为第一节点并固定使用 `replay="msg_id"`；媒体 `src` 必须逐字匹配宿主提供的安全句柄，未知、缺失、重复、重排或跨类型引用全部失败关闭。改写完成后的正文和消息包只持久化一次，outbox 重试、断线恢复和重启投递不得再次调用 tone。启用时空输出、Tone 订正后仍非法的 XML、取消、超时、Provider 错误或重试耗尽均失败关闭，不能绕过节点发送原文；`dispatch_message` 改写后仍须非空且不超过 200 字。`system_config` 确认必须先完成 tone 并成功写入 held outbox，随后才能提交配置。
- OneBot 发送入口使用版本化 `OutboundBubbleV1`。旧回复方式由宿主包装为单个 `message` 气泡，XML 分段回复按节点包装为多个 `message` 气泡；普通图片与表情仍使用消息媒体段，语音、图片文件和普通文件使用同一协议中的 `asset` 气泡并继续服从各自 durable outbox 的来源、文件身份与权限校验。表情在 Sunabot durable `contentSegments` 中使用 `sticker`，OneBot adapter 固定映射为 `image` 且携带 `sub_type=1`；普通生成图片继续使用不携带该 subtype 的 `image`。`sticker` 不生成商城表情所需的 `emoji_id` 或 `emoji_package_id`。协议分派后才调用 `send_msg`、`record` 或文件上传 action，模型输出不能直接选择账号、QQ 目标、宿主路径或 OneBot action。
- 当前 Agent 的表情图库通过正文标记 `[/key]` 参与 OneBot 回复，例如当前列表中的 `开心` 必须写成 `[/开心]`，不能添加“表情”等前缀。宿主在 `before_reply` 前冻结初始标记计划，单条回复最多识别 4 个当前图库中的 key；纯标记回复跳过 tone，正文与标记混合时只调用一次 tone，并以受控分段保护精确 raw token、顺序和文本分段骨架。分段 Tone 的 `<exp>` 只能逐字使用本轮明确允许的标记；允许列表为空时不得输出 `<exp>`。hook 或 tone 新增、删除、改写、移动标记都失败关闭；未知 key、反斜杠转义标记和带空白的近似写法按普通正文保留。写入 outbox 前，已知标记按原位置转换为有序文字与图片 segment，并异步复验当前 Agent 的 SQLite 记录、内容寻址文件和文件身份；重试、断线恢复和重启只投递已经持久化的 segment，不重复执行 hook、tone 或标记规划。`bot.emojiSendSeparately` 默认关闭；开启后，含正文或普通生成图的回复先写入一条 outbox，全部表情再写入紧随其后的独立 outbox，第二条不重复引用或 @，纯表情回复仍只写入一条。纯表情发送成功后不新增 assistant 会话记录，不写入记忆队列。OneBot 发送前再次限制实际发出的内容寻址表情不超过 4 个，并把全部本地内联图片按实际出现次数计入 32 MiB 原始字节总预算；相同文件只读取一次，读取并发最多 2，任一读取、完整性、顺序或预算失败时整条消息保持零发送。
- Codex 与图像生成长任务先返回确认消息，任务完成后通过持久化事件恢复原会话；任务提交不能等待生成完成。所有 deferred tool 必须单独调用并携带非空 `dispatch_message`，由模型使用当前人格生成“已收到并开始处理”的短消息；该字段与任务在同一事务中落库为 acknowledgement，进入 worker 前从业务参数中删除。事务提交后 acknowledgement outbox 与 worker 独立调度，消息发送、重试或结果不确定不能阻塞任务 claim 和执行；callback 按同一会话 outbox FIFO 排在 acknowledgement 之后。缺失、空白或超过 200 字时不得派发，也不得降级为同步执行。
- `assistant_text` 允许 Agent 在工具循环中发送中间消息。中间消息必须在当前 turn 仍运行时写入 SQLite outbox 并立即调度发送，持久化完成后即可继续下一项 inline 工具；发送与重试由 outbox 独立执行，不能在 Provider 工具循环结束后才批量写入。重试同一事件时按事件 ID 与中间消息序号去重。群聊只引用第一条中间消息，最终正文仍引用原始消息，后续中间消息不引用。
- 一次 Provider completion 共享同一个 `TurnToolState`，跨模型轮次记录已发送的 `assistant_text`、已接受工具、deferred 状态和调用次数。Responses、Chat Completions、Anthropic、Gemini 和 Codex 均拒绝 `assistant_text → no_reply`、普通工具 → `no_reply` 和 `assistant_text → deferred` 等非法顺序，合法的首轮独立 `no_reply` 与 deferred 调用保持原行为。
- `system_config` 修改使用 staged mutation 与 held confirmation 两阶段提交。它只能在当前 Agent 的管理员 QQ 私聊中作为整个 Provider turn 的唯一工具调用，并且最终确认必须是纯文本；同一 turn 在它前后出现 `assistant_text`、图片、deferred 或任何其他工具时整轮拒绝，已暂存修改丢弃。宿主先以稳定 `mutationFingerprint` 调用 `appendHeld`，确认正文成功写入 durable outbox 后提交配置，再原子释放原确认；远端离线、重试和 receipt/settle 不回滚已提交配置。append 未发生、append 失败、正文为空、`before_reply` 中止或回复门控竞态时不得提交。commit 失败后，held 记录只能原子改为“设置结果未确认，请重新查询当前设置”并释放；该原子操作失败时原成功确认保持 held 且不可 claim，不能退回普通 emit。release 响应丢失与恢复操作必须幂等，重启发现无法证明 mutation 已提交的遗留 held 记录时只释放中性通知，不执行或猜测配置修改。
- `mutationFingerprint` 使用 SHA-256 绑定 Agent ID、完整 conversation ID、当前管理员 user ID、action、规范化参数和是否关闭当前私聊门控；不包含回复正文、时间、worker、随机 call ID、attempt 或密钥明文。同一事件重试只能复用相同 fingerprint，不同 fingerprint 必须失败关闭。session queue schema v5 使用 `none`、`held`、`released`、`fallback_released` 四种状态，并保存版本化 hold/release provenance；`appendHeld` 在单一事务中直接插入 held 行，与普通 outbox 共用事件 ordinal，禁止先写普通行再更新为 held。held 行不可 claim，会同时阻塞所属会话和投递分区 FIFO，但不阻塞其他分区；release 或原子中性化成功后才可投递。
- 只有宿主确认“管理员私聊、纯文本、唯一 `system_config` trace、该 mutation 明确关闭当前私聊自动回复”后，才可在确认 outbox 写入 `deliverySemantics: "system_config_confirmation"`。decoder 只接受缺省值或该唯一字面量。release 必须把当时的 ReplyGate 写入 store provenance：同 generation 下，不关闭私聊门控的确认要求 epoch 全部不变，关闭私聊门控只允许 private scope epoch 恰好增加 1 且 conversation epoch 不变；其他 scope、conversation、account 或 sender 变化均拒绝。跨 generation 只允许恢复出的 `fallback_released` 使用当前 private scope/conversation epoch 均为 0 的门控；已在旧 generation 成功 release 的记录投递时也只接受新 runtime 当前门控为 0/0。投递继续校验当前管理员、私聊范围、无 group ID、正文、工具 trace、会话记录、account ID、gateway、FIFO、重试、remote receipt 和 settle；模型参数、普通正文、`assistant_text`、deferred、图片、其他工具和外部 API payload 不能获得旁路。
- 启动恢复必须在同一事务中把无法证明已提交的 held 成功文案改为固定中性通知，并终结其 origin running turn 与队首事件；已经 released 但尚未 finish 的 turn 直接终结，不能再次调用 Provider 或重复提交配置。构造期恢复必须显式提供当前 runtime 的 ReplyGate resolver；存在 held 行但 resolver 缺失时整个恢复事务失败关闭，不能留下仍在 running 的 origin 或部分恢复状态。成功 durable append、配置 commit 与 release 全部完成后，immediate confirmation 的 origin turn 以 `replied` 终结；store 中可信 `released` provenance 也会在 release 响应丢失时把最终 turn 收敛为 `replied`，不能写入失败或 `no_reply` 统计。关闭当前私聊门控只能保护该次已持久化 confirmation 不被自身配置提交取消，其他会话、门控、超时和取消继续生效。`finishTurn`、`deferTurn` 和失败路径都对遗留 held 行执行同一安全网，并在可投递后调度 outbox。`delivery_unknown` replay 对 released/fallback 记录使用稳定 replay key，逐层保留 mutation fingerprint 与可信 lineage，最多 8 层；每层源行必须仍为无不确定 settle 的 `delivery_unknown` 且 payload、session、turn、kind、partition 和 release provenance 全部一致。普通 `hold_state=none` 或只有 payload marker 的记录不能通过 replay 升格。
- `no_reply` 允许 Agent 在本轮无需回复、话题已经自然结束，或继续回应其他 Bot 可能引起循环广播时静默结束。该工具必须在发送任何中间消息或调用其他工具前单独调用；接受后本轮直接以 `no_reply` 结束，不生成 Bot 消息，也不发送文字或错误回复。`bot.pokeOnNoReply` 默认关闭；开启后仅为当前 QQ 账号与触发者创建 `onebot.poke` outbox，群聊携带原群号，私聊不携带群号，turn 状态仍为 `no_reply`。
- `bot.quoteGroupReplyExcludedUserIds` 按 Agent 保存 QQ 号过滤名单。开启群聊引用时，回复名单中的发送者仍正常发送正文，但第一条中间消息、最终正文和错误回复都不引用触发消息；其他发送者维持原引用行为。
- 新写入的 Bot 消息持久化 `messageOrigin` 与按首次调用顺序去重的 `toolNames`。来源区分普通正文 `text`、显式 `assistant_text`、异步受理 `async_tool_dispatch` 和 callback 结果 `async_tool_callback`；工具清单只记录本轮实际接受的 Function Call，不能使用 Provider 请求中的可用工具定义反推。即时 `assistant_text` 的 durable outbox 保存发送时已经接受的工具前缀，turn 完成后会话投影按同一 `logRunId` 收敛为本轮完整工具清单。旧消息缺少来源时保持未知，不按正文、时间或日志邻近猜测。
- 会话最多保留 2,000 条消息，最多保留最近 80 个会话。

### 3.6 日常导演主动分享

每个 Agent 的日常导演在系统时区每日 07:00 后确保当天行程存在；Core 在 07:00 后启动或重启时立即补建，07:00 前只等待分钟级唤醒。当天已有行程时不得重复调用计划 Provider。每个启用且非 Web Chat 的既有 QQ 会话都是当天分享候选，目标按完整会话 ID 排序并以最多 20 个一组写入确定性 one-time 定时任务；会话启停集合在分享触发前变化时，尚未到期的同 revision 任务必须幂等替换，不能因 ID 冲突停止调度。

每个 share 节点必须落在所属活动时间内、具有文本意图和现场自拍提示，并在当前时间之后才创建任务。任务回调复用 `scheduled_callback` 的正常 private/group Agent loop、目标账号、Session FIFO 与 outbox；回调上下文只提供人物、现场、动作、服装和自拍意图，要求当前角色以本人视角自然分享日常并在同一 turn 调用 `selfie`。最终回复不得暴露定时、计划、规划、日程、任务、触发、回调、cron、导演、系统、提示词、字段或预设等元信息，也不得使用“按照计划”“今天安排”“到点了”“提醒一下”“定时分享”等表述。任务不能绕过目标会话、Agent/account 隔离或媒体安全边界，也不能向 Web Chat 主动投递。行程 revision 变化时，旧 revision 尚未执行的任务与链接被删除，新 revision 使用新的确定性 ID 创建；已经到期的历史不被重放。

普通定时任务生成结果后按目标创建幂等 Session 事件；目标投递失败写入 run 的 `delivery_attempts`、`last_delivery_error` 和 `next_delivery_at`，以带随机抖动的有界指数退避最多尝试三次。第三次失败转为持久 `failed` 终态，不再由调度循环无限 claim；Core 重启只恢复尚未到期的下一次投递或未超过上限的 run。管理员可从失败记录发起一次显式重新投递，服务端原子清理旧投递错误并把既有生成结果恢复为可 claim 状态，不重复生成正文，也不允许对非失败记录执行该操作。

### 3.7 Dream 与会话边界

Dream 只读取当前 Agent 在当日睡眠窗口内已经持久化的会话投影，并以有界、去标识化的模型输入参与记忆整理。每日 04:00 自动运行不建立用户 turn、内部回调、Session 事件、outbox 或 OneBot 外发；生成失败只进入 Dream 运行状态和请求日志，不向任一会话发送错误消息。管理员手动触发时，运行权持久化成功后向所选 Agent 的在线 QQ 账号与已配置管理员私聊排入一次 `scheduled_callback`；回调沿既有 Session、完整 Agent loop、durable outbox 和 OneBot 出站链路投递，由当前人格、关系与可编辑提示词生成“已经睡着、正在进入梦境”的即时消息，业务层不能硬编码最终文案或直接调用 Gateway。当天已完成、运行中、缺少在线账号或缺少有效管理员 QQ 时拒绝触发且不排入通知；通知入队失败时本次 Dream 终止为不可自动重试失败，管理员可再次手动触发。

Dream 的自动 claim 使用三次总尝试上限；第三次可重试失败也必须直接持久化为 `failed`，不能再次回到 pending。强制手动触发、租约恢复或成功完成会清空旧的 `error_code`、`error_text` 与 `failed_at`，历史错误不得污染新一轮状态。

普通回复只有把长期记忆实际注入本轮模型上下文时才记录召回；管理台搜索、Dream 素材选择和其他只读查询不增加计数。同一 `logRunId` 中初始召回与 `memory_recall` 工具重复命中同一长期记忆时只计一次，避免工具循环放大使用频率。
