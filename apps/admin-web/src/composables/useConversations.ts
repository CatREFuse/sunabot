import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type { ConversationLogEntry, ConversationMessagePage, ConversationMessageRecord, ConversationRecord, ConversationStatsPayload } from "../types";

export function useConversations() {
  const conversations = shallowRef<ConversationRecord[]>([]);
  const messages = shallowRef<ConversationMessageRecord[]>([]);
  const memberNames = shallowRef<Record<string, string>>({});
  const logs = shallowRef<ConversationLogEntry[]>([]);
  const stats = shallowRef<ConversationStatsPayload | null>(null);
  const nextBeforeSequence = shallowRef<number | undefined>();
  const hasMore = shallowRef(false);
  const loadingList = shallowRef(false);
  const loadingMessages = shallowRef(false);
  const loadingLogs = shallowRef(false);
  const error = shallowRef("");
  let listController: AbortController | undefined;
  let messageController: AbortController | undefined;
  let logController: AbortController | undefined;
  let statsController: AbortController | undefined;

  async function loadList() {
    listController?.abort();
    listController = new AbortController();
    loadingList.value = true;
    try {
      const payload = await apiRequest<{ conversations: ConversationRecord[] }>("/api/conversations", { signal: listController.signal });
      conversations.value = payload.conversations;
      error.value = "";
    } catch (caught) {
      if (isAbort(caught)) return;
      error.value = caught instanceof Error ? caught.message : "会话读取失败";
    } finally {
      loadingList.value = false;
    }
  }

  async function loadMessages(id: string, options: { older?: boolean; reset?: boolean } = {}) {
    messageController?.abort();
    messageController = new AbortController();
    loadingMessages.value = true;
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (options.older && nextBeforeSequence.value != null) params.set("before", String(nextBeforeSequence.value));
      const page = await apiRequest<ConversationMessagePage>(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`, { signal: messageController.signal });
      if (options.reset) messages.value = page.messages;
      else messages.value = mergeMessages(options.older ? [...page.messages, ...messages.value] : [...messages.value, ...page.messages]);
      memberNames.value = page.memberNames ?? {};
      if (options.reset || options.older || messages.value.length === page.messages.length) {
        hasMore.value = page.hasMore;
        nextBeforeSequence.value = page.nextBeforeSequence;
      }
      error.value = "";
    } catch (caught) {
      if (isAbort(caught)) return;
      error.value = caught instanceof Error ? caught.message : "消息读取失败";
    } finally {
      loadingMessages.value = false;
    }
  }

  async function loadLogs(id: string, runId?: string) {
    logController?.abort();
    logController = new AbortController();
    loadingLogs.value = true;
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (runId) params.set("runId", runId);
      const payload = await apiRequest<{ logs: ConversationLogEntry[] }>(`/api/conversations/${encodeURIComponent(id)}/logs?${params}`, { signal: logController.signal });
      logs.value = payload.logs;
    } catch (caught) {
      if (isAbort(caught)) return;
      error.value = caught instanceof Error ? caught.message : "日志读取失败";
    } finally {
      loadingLogs.value = false;
    }
  }

  async function loadStats(id: string) {
    statsController?.abort();
    statsController = new AbortController();
    try {
      stats.value = await apiRequest<ConversationStatsPayload>(
        `/api/conversations/${encodeURIComponent(id)}/stats`,
        { signal: statsController.signal }
      );
    } catch (caught) {
      if (isAbort(caught)) return;
      error.value = caught instanceof Error ? caught.message : "统计读取失败";
    }
  }

  async function updateReplySettings(
    conversation: ConversationRecord,
    changes: Pick<ConversationRecord, "replyEnabled" | "orchestratorEnabled">
  ) {
    const previous = conversations.value;
    conversations.value = previous.map((item) =>
      item.id === conversation.id ? { ...item, ...changes } : item
    );
    try {
      const payload = await apiRequest<{ conversation: ConversationRecord }>("/api/conversations/reply", {
        method: "PUT",
        body: JSON.stringify({
          id: conversation.id,
          scope: conversation.scope,
          title: conversation.title,
          userId: conversation.userId,
          groupId: conversation.groupId,
          ...changes
        })
      });
      conversations.value = conversations.value.map((item) => item.id === payload.conversation.id
        ? {
            ...item,
            replyEnabled: payload.conversation.replyEnabled,
            orchestratorEnabled: payload.conversation.orchestratorEnabled
          }
        : item);
      error.value = "";
    } catch (caught) {
      conversations.value = previous;
      error.value = caught instanceof Error ? caught.message : "回复状态更新失败";
    }
  }

  async function setReplyEnabled(conversation: ConversationRecord, replyEnabled: boolean) {
    await updateReplySettings(conversation, { replyEnabled });
  }

  async function setOrchestratorEnabled(conversation: ConversationRecord, orchestratorEnabled: boolean) {
    await updateReplySettings(conversation, { orchestratorEnabled });
  }

  function clearCurrent() {
    messageController?.abort();
    logController?.abort();
    messages.value = [];
    memberNames.value = {};
    logs.value = [];
    stats.value = null;
    hasMore.value = false;
    nextBeforeSequence.value = undefined;
  }

  function dispose() {
    listController?.abort();
    messageController?.abort();
    logController?.abort();
    statsController?.abort();
  }

  return {
    conversations: shallowReadonly(conversations),
    messages: shallowReadonly(messages),
    memberNames: shallowReadonly(memberNames),
    logs: shallowReadonly(logs),
    stats: shallowReadonly(stats),
    hasMore: shallowReadonly(hasMore),
    loadingList: shallowReadonly(loadingList),
    loadingMessages: shallowReadonly(loadingMessages),
    loadingLogs: shallowReadonly(loadingLogs),
    error: shallowReadonly(error),
    loadList,
    loadMessages,
    loadLogs,
    loadStats,
    setReplyEnabled,
    setOrchestratorEnabled,
    clearCurrent,
    dispose
  };
}

function mergeMessages(values: ConversationMessageRecord[]) {
  const map = new Map(values.map((item) => [item.id, item]));
  return [...map.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.at.localeCompare(b.at));
}
function isAbort(value: unknown) { return value instanceof DOMException && value.name === "AbortError"; }
