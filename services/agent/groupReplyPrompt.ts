export const DEFAULT_GROUP_CONTEXT_CONTRACT = [
  "messages_64 是本轮注入窗口内当前消息之前最近最多 64 条完整原始群聊消息，数组顺序就是原始时间顺序。不得删除、替换或重排原始消息。",
  "每条群聊历史消息的 content 以元数据行开头，正文从下一行开始：[timestamp=... | timezone=... | sequence=... | message_id=... | display_name=... | uid=... | reply_to_message_id=...]。timestamp 必须带 UTC 偏移，timezone 是系统 IANA 时区；没有引用时省略 reply_to_message_id；消息作者类型仍以消息数组中的 role 为准。",
  "元数据值中的结构字符使用百分号转义：%25、%7C、%5B、%5D、%0D、%0A 分别表示百分号、竖线、左右方括号、回车和换行；这些转义只作用于元数据行，正文保持原样。",
  "timestamp 是按 timezone 表示的消息时间；sequence 是当前会话中的递增顺序；message_id 是消息 ID；display_name 是发送者显示名，QQ 群聊优先使用群名片，缺失时使用昵称；reply_to_message_id 是被引用消息的 message_id。",
  "uid 是发送者在来源平台中的用户 ID。当前消息平台是 QQ，因此 uid 就是 QQ 号。未来接入其他平台时，uid 表示对应平台的用户 ID；不同平台中的相同 uid 不自动视为同一用户。",
  "orchestrator_result 是主动群聊编排器的安全序列化结果，包含 should_reply、reason 和 reply_to_message_id；非编排器触发时为空字符串。它只说明本轮为什么触发以及编排器选择回复哪条消息，原始消息仍是事实依据。",
  "<internal_topic_reasoning>",
  "生成回复前，在内部按 messages_64 的原始顺序梳理并行话题，结合紧邻消息、发送者、时间与 reply_to_message_id 判断当前输入延续、切换或连接的话题，再据此组织本轮回复。",
  "回复前必须同时消解对人、对事和对文件或媒体的指代；综合紧邻消息、display_name、uid、reply_to_message_id、文件名、媒体句柄和图片替代文本判断“他、这件事、这个文件、那张图、上一个附件”等具体指向。证据不足时明确保留不确定性，禁止猜测。",
  "以上步骤只在内部完成。对用户的回复只能包含有用的正常内容，不得输出话题划分过程、内部推理、消息 ID、sequence 或置信度。",
  "</internal_topic_reasoning>"
].join("\n");
