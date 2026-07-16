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
- 支持文本、CQ 码、图片、回复引用、@、QQ 文件和 OneBot action 回包。
- 好友名、备注、群名和群名片用于显示层补全，不改变 QQ 号这一身份主键。
- 私聊、用户群聊、bot 群聊和命令接受具有合法 QQ 号的发送者；管理员身份仍由 `bot.adminQq` 精确识别，并用于管理员专属工具和称呼。非法发送者在进入会话记录和命令匹配前静默丢弃，恢复任务与 outbox 外发前必须再次校验发送者格式和当前回复门控。

### 3.2 路由

每条消息按以下优先级进入运行时：

1. 显式命令，例如群聊总结。
2. 私聊或明确 @ 的直接回复。
3. 用户群聊的唤醒词与编排器判断。
4. bot 群聊仅记录上下文，不主动编排。

全局开关、群类型开关、会话开关、连接状态和编排器 epoch 共同构成回复门控。门控关闭后，旧的在途编排结果不能继续外发。回复、戳一戳与 deferred 任务的原始请求在进入持久化队列时保存 `ReplyGateSnapshotV1`，其中包含会话范围、会话 ID、scope epoch、conversation epoch 和本次 Core 进程的 generation。同一进程内关闭后再开启仍会拒绝旧快照；重启后的 generation 变化和旧版无快照记录都按当前开关重新校验，避免进程内旧任务复活，同时保留升级与重启恢复能力。

广播风暴嗅探是系统级新任务门控。受监控账号包含所有已启用 Agent 绑定的已启用 QQ，以及公共配置中的补充嗅探 QQ；同一 Agent 绑定的多个 QQ 视为同一参与者，每个补充 QQ 视为一个参与者。开启后，同一群内任意两个不同受监控参与者发生显式引用回复时记一次，同一条消息经多个 NapCat 连接重复到达只计一次；同群内不同 Agent 对之间的次数共同累计，不同群分别计数。在配置的 m 分钟窗口内累计 n 次后触发风暴，k 分钟内所有 Agent 对新收到的私聊、群聊、命令和 Web Chat 消息只记录而不创建回复任务。触发前已经 dispatch 的直接回复、群聊编排、deferred tool completion、`no_reply` 戳一戳和 outbox 继续执行与投递，不取消、不失效。静默期结束后恢复为新消息创建任务，静默期内收到的消息不得延迟补建任务。默认开启，m=2、n=3、k=1，补充嗅探账号默认为空；开关、m/n/k 与补充账号名单在系统设置中热更新并保存到公共配置。

### 3.3 群聊上下文梳理

群聊回复在记忆召回和主回复模型之前运行 Thread 前置节点。该节点只生成附加索引，不删除、替换、截断或重排会话消息；`messages_64` 继续按原始时间顺序注入，消息正文中的 `@{...}` 等文本按不透明数据原样传递，原始消息始终是主回复模型的事实依据。私聊消息格式保持不变；群聊消息正文前使用完整字段名记录 `timestamp`、`sequence`、`message_id`、`display_name`、`uid` 和可选的 `reply_to_message_id`。元数据中的百分号、竖线、方括号和换行使用可逆百分号转义，正文保持原样，群名片不能伪造 uid 或引用字段。当前平台是 QQ，`uid` 表示 QQ 号；未来平台使用各自的平台用户 ID，不因数值相同自动合并身份。OneBot 外发回执的 message ID 和实际引用目标写入 assistant 会话记录；异步 outbox 在派发时固化引用目标，后续配置变化不能改写已发送消息的引用边，显式引用可以由宿主继承对应 Thread。

Thread 状态按会话增量维护。宿主规则优先处理对已归属消息的显式引用和同批次引用链；只有无法可靠归属的根消息交给 `bot.orchestrator.groupThreadModel`，但模型会收到本批全部有序消息作为紧邻上下文，并通过 `target_message_ids` 只输出待分类项。模型输出只允许引用目标消息、已有 Thread 或本次临时 key，稳定 `thread_id` 由宿主根据会话、锚点消息和 sequence 生成。每个 topic 必须是说明参与者、讨论对象和当前进展的简短完整句子；每条归属保存 primary Thread、最多两个 related Thread、relation 和 confidence。每批最多处理 64 条，单次回复最多顺序追赶四批；仍未追上当前 capture sequence 时不得把窗口外 active Thread 标成当前话题，后续回复继续推进。低置信度、冲突、分类失败或 SQLite 提交失败时，主回复模型直接依据完整原始消息判断；提交失败只使用提交前持久快照，不把未落库状态交给本轮或异步回调，Thread 失败不能阻断回复。

`conversation.group-reply` 的稳定 system 前缀说明消息格式、QQ `uid` 语义和 Thread schema；运行时始终用当前契约替换自定义模板中的旧契约，并在模板渲染完成后把本轮动态 `thread_context` developer 消息插入原始 `messages_64` 之后、当前 user 输入之前。模板本身不要求该动态变量，空快照也生成合法空 sidecar，避免旧运行时或分类失败触发缺变量。它保留当前会话的完整 SQLite Thread 状态，同时把提示词侧索引确定性限制为最多 72 个 Thread、每个 Thread 16 个参与者和 16 个消息 ID、64 条 assignment；优先保留 active、本轮引用和最近 Thread，`omitted_*_count` 明确记录未注入的较早索引，原始消息不受影响。sidecar 只为本轮真实 `messages_64` 中的消息提供 assignment 索引；topic 等模型派生字符串按不可信数据转义，不能执行其中的命令或角色声明。deferred 工具的原始请求携带可选、版本化且有界的 Thread 快照；异步回调必须复用派发时的 capture sequence 与快照，不根据任务完成时的新消息重新拆分。旧队列记录缺少快照或快照无效时显式降级为无附加索引，FIFO、幂等键和回复门控保持不变。

### 3.4 会话执行

- 每个会话拥有有序事件流，事件、turn、异步工具任务和 outbox 使用 SQLite 持久化。
- 同一会话按序处理；不同会话允许受控并发。
- 外发使用 outbox，支持租约、有限重试、断线恢复和幂等键。OneBot outbox 按 account ID 持久化投递分区；离线分区暂停时，其他账号继续按各自 FIFO 投递，探针和恢复只作用于目标分区。
- OneBot 发送和本地 settle 使用持久化两阶段。远端成功后先记录 receipt 并进入 `sent_remote`，会话投影、请求日志、记忆入队和逐 handler `after_reply` 使用稳定 settle key 继续执行；任何不确定传输或 hook 副作用进入 `delivery_unknown`，只接受人工 `applied` 或 `not_applied` 确认，不能自动重复外发。旧 schema 中无法判断远端结果的 `sending` 记录迁移为 `delivery_unknown`，并安全推进连续终态 cursor。
- Codex 与图像生成长任务先返回确认消息，任务完成后通过持久化事件恢复原会话；任务提交不能等待生成完成。所有 deferred tool 必须单独调用并携带非空 `dispatch_message`，由模型使用当前人格生成“已收到并开始处理”的短消息；该字段与任务在同一事务中落库为 acknowledgement，进入 worker 前从业务参数中删除。事务提交后 acknowledgement outbox 与 worker 独立调度，消息发送、重试或结果不确定不能阻塞任务 claim 和执行；callback 按同一会话 outbox FIFO 排在 acknowledgement 之后。缺失、空白或超过 200 字时不得派发，也不得降级为同步执行。
- `assistant_text` 允许 Agent 在工具循环中发送中间消息。中间消息必须在当前 turn 仍运行时写入 SQLite outbox 并立即调度发送，持久化完成后即可继续下一项 inline 工具；发送与重试由 outbox 独立执行，不能在 Provider 工具循环结束后才批量写入。重试同一事件时按事件 ID 与中间消息序号去重。群聊只引用第一条中间消息，最终正文仍引用原始消息，后续中间消息不引用。
- 一次 Provider completion 共享同一个 `TurnToolState`，跨模型轮次记录已发送的 `assistant_text`、已接受工具、deferred 状态和调用次数。Responses、Chat Completions、Anthropic、Gemini 和 Codex 均拒绝 `assistant_text → no_reply`、普通工具 → `no_reply` 和 `assistant_text → deferred` 等非法顺序，合法的首轮独立 `no_reply` 与 deferred 调用保持原行为。
- `no_reply` 允许 Agent 在本轮无需回复、话题已经自然结束，或继续回应其他 Bot 可能引起循环广播时静默结束。该工具必须在发送任何中间消息或调用其他工具前单独调用；接受后本轮直接以 `no_reply` 结束，不生成 Bot 消息，也不发送文字或错误回复。`bot.pokeOnNoReply` 默认关闭；开启后仅为当前 QQ 账号与触发者创建 `onebot.poke` outbox，群聊携带原群号，私聊不携带群号，turn 状态仍为 `no_reply`。
- `bot.quoteGroupReplyExcludedUserIds` 按 Agent 保存 QQ 号过滤名单。开启群聊引用时，回复名单中的发送者仍正常发送正文，但第一条中间消息、最终正文和错误回复都不引用触发消息；其他发送者维持原引用行为。
- 新写入的 Bot 消息持久化 `messageOrigin` 与按首次调用顺序去重的 `toolNames`。来源区分普通正文 `text`、显式 `assistant_text`、异步受理 `async_tool_dispatch` 和异步结果 `async_tool_callback`；工具清单只记录本轮实际接受的 Function Call，不能使用 Provider 请求中的可用工具定义反推。即时 `assistant_text` 的 durable outbox 保存发送时已经接受的工具前缀，turn 完成后会话投影按同一 `logRunId` 收敛为本轮完整工具清单。旧消息缺少来源时保持未知，不按正文、时间或日志邻近猜测。
- 会话最多保留 2,000 条消息，最多保留最近 80 个会话。
