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

### 3.3 会话执行

- 每个会话拥有有序事件流，事件、turn、异步工具任务和 outbox 使用 SQLite 持久化。
- 同一会话按序处理；不同会话允许受控并发。
- 外发使用 outbox，支持租约、有限重试、断线恢复和幂等键。OneBot outbox 按 account ID 持久化投递分区；离线分区暂停时，其他账号继续按各自 FIFO 投递，探针和恢复只作用于目标分区。
- OneBot 发送和本地 settle 使用持久化两阶段。远端成功后先记录 receipt 并进入 `sent_remote`，会话投影、请求日志、记忆入队和逐 handler `after_reply` 使用稳定 settle key 继续执行；任何不确定传输或 hook 副作用进入 `delivery_unknown`，只接受人工 `applied` 或 `not_applied` 确认，不能自动重复外发。旧 schema 中无法判断远端结果的 `sending` 记录迁移为 `delivery_unknown`，并安全推进连续终态 cursor。
- Codex 与图像生成长任务先返回确认消息，任务完成后通过持久化事件恢复原会话；任务提交不能等待生成完成。所有 deferred tool 必须单独调用并携带非空 `dispatch_message`，由模型使用当前人格生成“已收到并开始处理”的短消息；该字段与任务在同一事务中落库为 acknowledgement，进入 worker 前从业务参数中删除。异步任务只有在关联 acknowledgement outbox 完成投递后才能由 worker claim，不能在 dispatch 消息仍待发送、发送中、重试或结果不确定时开始执行并产生 callback。缺失、空白或超过 200 字时不得派发，也不得降级为同步执行。
- `assistant_text` 允许 Agent 在工具循环中发送中间消息。群聊只引用第一条中间消息，最终正文仍引用原始消息，后续中间消息不引用。
- 一次 Provider completion 共享同一个 `TurnToolState`，跨模型轮次记录已发送的 `assistant_text`、已接受工具、deferred 状态和调用次数。Responses、Chat Completions、Anthropic、Gemini 和 Codex 均拒绝 `assistant_text → no_reply`、普通工具 → `no_reply` 和 `assistant_text → deferred` 等非法顺序，合法的首轮独立 `no_reply` 与 deferred 调用保持原行为。
- `no_reply` 允许 Agent 在本轮无需回复、话题已经自然结束，或继续回应其他 Bot 可能引起循环广播时静默结束。该工具必须在发送任何中间消息或调用其他工具前单独调用；接受后本轮直接以 `no_reply` 结束，不生成 Bot 消息，也不发送文字或错误回复。`bot.pokeOnNoReply` 默认关闭；开启后仅为当前 QQ 账号与触发者创建 `onebot.poke` outbox，群聊携带原群号，私聊不携带群号，turn 状态仍为 `no_reply`。
- `bot.quoteGroupReplyExcludedUserIds` 按 Agent 保存 QQ 号过滤名单。开启群聊引用时，回复名单中的发送者仍正常发送正文，但第一条中间消息、最终正文和错误回复都不引用触发消息；其他发送者维持原引用行为。
- 新写入的 Bot 消息持久化 `messageOrigin` 与按首次调用顺序去重的 `toolNames`。来源区分普通正文 `text`、显式 `assistant_text`、异步受理 `async_tool_dispatch` 和异步结果 `async_tool_callback`；工具清单只记录本轮实际接受的 Function Call，不能使用 Provider 请求中的可用工具定义反推。旧消息缺少来源时保持未知，不按正文、时间或日志邻近猜测。
- 会话最多保留 2,000 条消息，最多保留最近 80 个会话。
