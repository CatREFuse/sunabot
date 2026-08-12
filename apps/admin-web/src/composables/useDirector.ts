import { computed, readonly, shallowRef } from "vue";
import type { ConfigEnvelope, ConfigPatchResponse, ConversationRecord } from "../types";
import type { DirectorSchedule, DirectorSchedulesResponse } from "../types/director";
import { ApiRequestError, apiRequest } from "./useAdminApi";

export function useDirector() {
  const pageSize = 14;
  const enabled = shallowRef(false);
  const revision = shallowRef("");
  const schedules = shallowRef<DirectorSchedule[]>([]);
  const conversations = shallowRef<ConversationRecord[]>([]);
  const savingConversationIds = shallowRef<string[]>([]);
  const pagination = shallowRef({ page: 1, pageSize, total: 0, pageCount: 1 });
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const message = shallowRef("");
  const messageKind = shallowRef<"idle" | "success" | "error">("idle");
  let activeAgentId = "";
  let generation = 0;
  let controller: AbortController | undefined;

  async function load(agentId: string) {
    activate(agentId);
    const context = generation;
    loading.value = true;
    clearMessage();
    try {
      const [configResult, historyResult, conversationsResult] = await Promise.allSettled([
        request<ConfigEnvelope>("/api/config", agentId),
        loadPage(agentId, pagination.value.page),
        request<{ conversations: ConversationRecord[] }>("/api/conversations", agentId)
      ]);
      if (!current(agentId, context)) return false;
      let complete = true;
      if (configResult.status === "fulfilled") {
        const config = configResult.value;
        enabled.value = config.config.bot.director?.enabled === true;
        revision.value = config.revision;
      } else {
        setError(configResult.reason, "导演系统状态读取失败");
        complete = false;
      }
      if (historyResult.status === "fulfilled") {
        applyHistory(historyResult.value);
      } else {
        if (complete) setError(historyResult.reason, "每日决策读取失败");
        complete = false;
      }
      if (conversationsResult.status === "fulfilled") {
        conversations.value = Array.isArray(conversationsResult.value.conversations)
          ? [...conversationsResult.value.conversations]
          : [];
      } else {
        if (complete) setError(conversationsResult.reason, "发送会话读取失败");
        complete = false;
      }
      return complete;
    } catch (error) {
      if (!current(agentId, context) || isAbort(error)) return false;
      setError(error, "导演系统读取失败");
      return false;
    } finally {
      if (current(agentId, context)) loading.value = false;
    }
  }

  async function setEnabled(agentId: string, nextEnabled: boolean) {
    activate(agentId);
    if (saving.value || nextEnabled === enabled.value) return false;
    if (!revision.value.trim()) {
      setError(undefined, "导演系统状态尚未加载");
      return false;
    }
    const context = generation;
    saving.value = true;
    clearMessage();
    try {
      let result: ConfigPatchResponse;
      try {
        result = await patchEnabled(agentId, nextEnabled, revision.value);
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 409) throw error;
        const latest = await request<ConfigEnvelope>("/api/config", agentId);
        if (!current(agentId, context)) return false;
        revision.value = latest.revision;
        result = await patchEnabled(agentId, nextEnabled, latest.revision);
      }
      if (!current(agentId, context)) return false;
      enabled.value = result.config.bot.director?.enabled === true;
      revision.value = result.revision;
      messageKind.value = "success";
      message.value = enabled.value ? "导演系统已开启" : "导演系统已关闭";
      return true;
    } catch (error) {
      if (!current(agentId, context) || isAbort(error)) return false;
      setError(error, "导演系统状态更新失败");
      return false;
    } finally {
      if (current(agentId, context)) saving.value = false;
    }
  }

  async function changePage(agentId: string, page: number) {
    activate(agentId);
    if (loading.value || page < 1 || page > pagination.value.pageCount || page === pagination.value.page) return false;
    const context = generation;
    loading.value = true;
    try {
      const history = await loadPage(agentId, page);
      if (!current(agentId, context)) return false;
      applyHistory(history);
      return true;
    } catch (error) {
      if (!current(agentId, context) || isAbort(error)) return false;
      setError(error, "每日决策读取失败");
      return false;
    } finally {
      if (current(agentId, context)) loading.value = false;
    }
  }

  async function setConversationEnabled(agentId: string, conversationId: string, nextEnabled: boolean) {
    activate(agentId);
    const currentRecord = conversations.value.find((item) => item.id === conversationId);
    if (!currentRecord || savingConversationIds.value.includes(conversationId)) return false;
    if ((currentRecord.directorEventsEnabled === true) === nextEnabled) return false;
    const context = generation;
    savingConversationIds.value = [...savingConversationIds.value, conversationId];
    clearMessage();
    try {
      const result = await request<{ conversation: ConversationRecord }>("/api/conversations/reply", agentId, {
        method: "PUT",
        body: JSON.stringify({ id: conversationId, directorEventsEnabled: nextEnabled })
      });
      if (!current(agentId, context)) return false;
      conversations.value = conversations.value.map((item) => (
        item.id === conversationId ? result.conversation : item
      ));
      messageKind.value = "success";
      message.value = nextEnabled ? "发送会话已开启" : "发送会话已关闭";
      return true;
    } catch (error) {
      if (!current(agentId, context) || isAbort(error)) return false;
      setError(error, "发送会话状态更新失败");
      return false;
    } finally {
      if (current(agentId, context)) {
        savingConversationIds.value = savingConversationIds.value.filter((id) => id !== conversationId);
      }
    }
  }

  function dispose() {
    generation += 1;
    controller?.abort();
  }

  function activate(agentId: string) {
    const normalized = agentId.trim();
    if (normalized === activeAgentId && controller) return;
    activeAgentId = normalized;
    generation += 1;
    controller?.abort();
    controller = new AbortController();
    schedules.value = [];
    conversations.value = [];
    savingConversationIds.value = [];
    pagination.value = { page: 1, pageSize, total: 0, pageCount: 1 };
    enabled.value = false;
    revision.value = "";
  }

  function current(agentId: string, context: number) {
    return agentId.trim() === activeAgentId && context === generation && !controller?.signal.aborted;
  }

  function loadPage(agentId: string, page: number) {
    return request<DirectorSchedulesResponse>(
      `/api/director/schedules?page=${page}&pageSize=${pageSize}`,
      agentId
    );
  }

  function patchEnabled(agentId: string, nextEnabled: boolean, currentRevision: string) {
    return request<ConfigPatchResponse>("/api/config/director", agentId, {
      method: "PATCH",
      body: JSON.stringify({ revision: currentRevision, value: { enabled: nextEnabled } })
    });
  }

  function request<T>(path: string, agentId: string, init: RequestInit = {}) {
    const separator = path.includes("?") ? "&" : "?";
    return apiRequest<T>(`${path}${separator}agentId=${encodeURIComponent(agentId.trim())}`, {
      ...init,
      signal: controller?.signal
    });
  }

  function applyHistory(response: DirectorSchedulesResponse) {
    schedules.value = Array.isArray(response.schedules) ? [...response.schedules] : [];
    pagination.value = {
      page: positive(response.pagination?.page, 1),
      pageSize: positive(response.pagination?.pageSize, pageSize),
      total: nonNegative(response.pagination?.total),
      pageCount: positive(response.pagination?.pageCount, 1)
    };
  }

  function clearMessage() {
    messageKind.value = "idle";
    message.value = "";
  }

  function setError(error: unknown, fallback: string) {
    messageKind.value = "error";
    message.value = error instanceof Error && error.message.trim() ? error.message : fallback;
  }

  return {
    enabled: readonly(enabled),
    revision: readonly(revision),
    schedules: readonly(schedules),
    conversations: readonly(conversations),
    savingConversationIds: readonly(savingConversationIds),
    pagination: readonly(pagination),
    loading: readonly(loading),
    saving: readonly(saving),
    message: readonly(message),
    messageKind: readonly(messageKind),
    busy: computed(() => loading.value || saving.value),
    load,
    setEnabled,
    setConversationEnabled,
    changePage,
    dispose
  };
}

function positive(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegative(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
