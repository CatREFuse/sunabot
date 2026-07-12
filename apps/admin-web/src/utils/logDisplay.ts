import type { ConversationLogEntry, OneBotEventTrace } from "../types";

const actionNames: Record<string, string> = {
  "responses.complete": "Responses 模型调用",
  "codex.complete": "Codex 订阅模型调用",
  "codex.tool.complete": "Codex 异步任务",
  "chat.completions.complete": "兼容模型调用",
  "anthropic.messages.complete": "Anthropic 模型调用",
  "gemini.generate-content.complete": "Gemini 模型调用",
  "image.generate": "图像生成",
  "codex.image.generate": "Codex 图像生成",
  "memory.recall.before_reply": "回复前记忆召回",
  "reply.started": "开始生成回复",
  "reply.sent": "回复已发送",
  "reply.failed": "回复失败",
  "reply.cancelled": "回复已取消"
};

const eventNames: Array<[RegExp, string]> = [
  [/^message\.private/, "收到私聊消息"],
  [/^message\.group/, "收到群聊消息"],
  [/^message_sent\.private/, "发送私聊消息"],
  [/^message_sent\.group/, "发送群聊消息"],
  [/^notice\.group_increase/, "群成员加入"],
  [/^notice\.group_decrease/, "群成员离开"],
  [/^notice\.group_admin/, "群管理员变更"],
  [/^notice\.group_upload/, "群文件上传"],
  [/^notice\.group_ban/, "群禁言变更"],
  [/^notice\.friend_add/, "好友新增"],
  [/^notice\.notify\.poke/, "收到戳一戳"],
  [/^request\.friend/, "好友请求"],
  [/^request\.group/, "群请求"],
  [/^meta_event\.lifecycle/, "OneBot 生命周期"],
  [/^meta_event\.heartbeat/, "OneBot 心跳"],
  [/^notice/, "OneBot 通知"],
  [/^request/, "OneBot 请求"],
  [/^meta_event/, "OneBot 元事件"]
];

export function requestLogDisplayName(log: ConversationLogEntry) {
  return actionNames[log.action] ?? "运行事件";
}

export function requestLogDirection(log: ConversationLogEntry) {
  if (log.category === "model.request") return "发送请求";
  if (log.category === "model.response") return "收到响应";
  return "运行记录";
}

export function oneBotEventId(event: OneBotEventTrace) {
  return [event.postType, event.messageType, event.detailType].filter(Boolean).join(".") || "onebot.event";
}

export function oneBotEventDisplayName(event: OneBotEventTrace) {
  const id = oneBotEventId(event);
  return eventNames.find(([pattern]) => pattern.test(id))?.[1] ?? "OneBot 事件";
}
