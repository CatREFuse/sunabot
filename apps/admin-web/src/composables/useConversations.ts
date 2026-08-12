import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type { ConversationLogEntry, ConversationMessagePage, ConversationMessageRecord, ConversationRecord, ConversationStatsPayload } from "../types";

type ConversationMutation = "reply" | "orchestrator" | "responseTime";
type ConversationMutationErrors = Partial<Record<ConversationMutation, string>>;

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
  const mutationBusy = shallowRef<Record<string, ConversationMutation | undefined>>({});
  const mutationErrors = shallowRef<Record<string, ConversationMutationErrors>>({});
  let listController: AbortController | undefined;
  let messageController: AbortController | undefined;
  let logController: AbortController | undefined;
  let statsController: AbortController | undefined;

  async function loadList(): Promise<boolean> {
    listController?.abort();
    listController = new AbortController();
    loadingList.value = true;
    try {
      const payload = await apiRequest<{ conversations: ConversationRecord[] }>("/api/conversations", { signal: listController.signal });
      conversations.value = payload.conversations;
      error.value = "";
      return true;
    } catch (caught) {
      if (isAbort(caught)) return false;
      error.value = caught instanceof Error ? caught.message : "会话读取失败";
      return false;
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
    changes: Pick<
      ConversationRecord,
      "replyEnabled"
      | "orchestratorEnabled"
      | "orchestratorResponseTimeOverrideEnabled"
      | "orchestratorResponseTimeMs"
    >,
    mutation: ConversationMutation
  ) {
    if (mutationBusy.value[conversation.id]) return false;
    const current = conversations.value.find((item) => item.id === conversation.id) ?? conversation;
    const previous = {
      replyEnabled: current.replyEnabled,
      orchestratorEnabled: current.orchestratorEnabled,
      orchestratorResponseTimeOverrideEnabled: current.orchestratorResponseTimeOverrideEnabled,
      orchestratorResponseTimeMs: current.orchestratorResponseTimeMs
    };
    setMutationBusy(conversation.id, mutation);
    setMutationError(conversation.id, mutation, "");
    conversations.value = conversations.value.map((item) =>
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
            orchestratorEnabled: payload.conversation.orchestratorEnabled,
            orchestratorResponseTimeOverrideEnabled:
              payload.conversation.orchestratorResponseTimeOverrideEnabled,
            orchestratorResponseTimeMs: payload.conversation.orchestratorResponseTimeMs,
            orchestratorStatus: payload.conversation.orchestratorStatus
          }
        : item);
      setMutationError(conversation.id, mutation, "");
      return true;
    } catch (caught) {
      conversations.value = conversations.value.map((item) => item.id === conversation.id
        ? {
            ...item,
            ...(changes.replyEnabled === undefined ? {} : { replyEnabled: previous.replyEnabled }),
            ...(changes.orchestratorEnabled === undefined ? {} : { orchestratorEnabled: previous.orchestratorEnabled }),
            ...(changes.orchestratorResponseTimeOverrideEnabled === undefined
              ? {}
              : {
                  orchestratorResponseTimeOverrideEnabled:
                    previous.orchestratorResponseTimeOverrideEnabled
                }),
            ...(changes.orchestratorResponseTimeMs === undefined
              ? {}
              : { orchestratorResponseTimeMs: previous.orchestratorResponseTimeMs })
          }
        : item);
      const message = caught instanceof Error
        ? caught.message
        : mutation === "reply" ? "回复设置保存失败" : "编排器设置保存失败";
      const refreshed = await loadList();
      setMutationError(
        conversation.id,
        mutation,
        refreshed ? `${message}，已重新读取当前状态` : `${message}，当前状态读取失败，请刷新`
      );
      return false;
    } finally {
      setMutationBusy(conversation.id, undefined);
    }
  }

  async function setReplyEnabled(conversation: ConversationRecord, replyEnabled: boolean) {
    return updateReplySettings(conversation, { replyEnabled }, "reply");
  }

  async function setOrchestratorEnabled(conversation: ConversationRecord, orchestratorEnabled: boolean) {
    return updateReplySettings(conversation, { orchestratorEnabled }, "orchestrator");
  }

  async function setOrchestratorResponseTimeOverrideEnabled(
    conversation: ConversationRecord,
    orchestratorResponseTimeOverrideEnabled: boolean
  ) {
    return updateReplySettings(
      conversation,
      { orchestratorResponseTimeOverrideEnabled },
      "responseTime"
    );
  }

  async function setOrchestratorResponseTime(
    conversation: ConversationRecord,
    orchestratorResponseTimeMs: number
  ) {
    return updateReplySettings(conversation, { orchestratorResponseTimeMs }, "responseTime");
  }

  function setMutationBusy(id: string, mutation: ConversationMutation | undefined) {
    const next = { ...mutationBusy.value };
    if (mutation) next[id] = mutation;
    else delete next[id];
    mutationBusy.value = next;
  }

  function setMutationError(id: string, mutation: ConversationMutation, message: string) {
    const next = { ...mutationErrors.value };
    const current = { ...next[id] };
    if (message) current[mutation] = message;
    else delete current[mutation];
    if (Object.keys(current).length) next[id] = current;
    else delete next[id];
    mutationErrors.value = next;
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
    mutationBusy: shallowReadonly(mutationBusy),
    mutationErrors: shallowReadonly(mutationErrors),
    loadList,
    loadMessages,
    loadLogs,
    loadStats,
    setReplyEnabled,
    setOrchestratorEnabled,
    setOrchestratorResponseTimeOverrideEnabled,
    setOrchestratorResponseTime,
    clearCurrent,
    dispose
  };
}

function mergeMessages(values: ConversationMessageRecord[]) {
  const map = new Map(values.map((item) => [item.id, item]));
  return [...map.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.at.localeCompare(b.at));
}
function isAbort(value: unknown) { return value instanceof DOMException && value.name === "AbortError"; }
