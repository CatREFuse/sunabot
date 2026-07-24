import type { ConversationMessageRecord, ConversationRecord } from "../types";

type ConversationIdentityRecord = Pick<
  ConversationRecord,
  "id" | "scope" | "title" | "userId" | "groupId" | "nickname" | "remark"
>;

export function qqAvatarUrl(userId: string | number | undefined) {
  const id = positiveId(userId);
  return id ? `/api/media/qq-avatar?kind=user&id=${encodeURIComponent(id)}` : "";
}

export function qqGroupAvatarUrl(groupId: string | number | undefined) {
  const id = positiveId(groupId);
  return id ? `/api/media/qq-avatar?kind=group&id=${encodeURIComponent(id)}` : "";
}

export function conversationAvatarUrl<T extends ConversationIdentityRecord>(conversation: T) {
  return conversation.groupId ? qqGroupAvatarUrl(conversation.groupId) : qqAvatarUrl(conversation.userId);
}

export function conversationAddress<T extends ConversationIdentityRecord>(conversation: T) {
  return conversation.groupId ? `群 ${conversation.groupId}` : `QQ ${conversation.userId}`;
}

export function conversationIdentityDetail<T extends ConversationIdentityRecord>(conversation: T) {
  if (conversation.groupId) return conversationAddress(conversation);
  const nickname = String(conversation.nickname ?? "").trim();
  const remark = String(conversation.remark ?? "").trim();
  return remark && nickname && remark !== nickname
    ? `QQ 昵称 ${nickname} · ${conversationAddress(conversation)}`
    : conversationAddress(conversation);
}

export function messageQq(message: ConversationMessageRecord, conversation: ConversationRecord) {
  const value = message.role === "assistant"
    ? message.selfId ?? conversation.selfId
    : message.userId;
  return positiveId(value);
}

function positiveId(value: string | number | undefined) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
}
