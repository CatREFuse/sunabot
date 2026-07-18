import { computed, readonly, shallowReadonly, shallowRef } from "vue";
import type { ConversationRecord } from "../types";
import type {
  ScheduledTask,
  ScheduledTaskConversationResponse,
  ScheduledTaskInput,
  ScheduledTasksResponse,
  ScheduledTaskStatus
} from "../types/scheduledTasks";
import { apiRequest } from "./useAdminApi";

export function useScheduledTasks() {
  const tasks = shallowRef<ScheduledTask[]>([]);
  const conversations = shallowRef<ConversationRecord[]>([]);
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const deletingId = shallowRef("");
  const togglingId = shallowRef("");
  const status = shallowRef<ScheduledTaskStatus>({ kind: "idle", message: "" });
  const mutationBusy = computed(() => saving.value || Boolean(deletingId.value) || Boolean(togglingId.value));
  let activeAgentId = "";
  let contextGeneration = 0;
  let loadGeneration = 0;
  let taskLoadGeneration = 0;
  let conversationLoadGeneration = 0;
  let taskController: AbortController | undefined;
  let conversationController: AbortController | undefined;

  async function load(agentId: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    status.value = { kind: "idle", message: "" };
    const context = contextGeneration;
    const generation = ++loadGeneration;
    loading.value = true;
    const [tasksLoaded] = await Promise.all([
      loadTasks(normalizedAgentId, context),
      loadConversations(normalizedAgentId, context)
    ]);
    if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) loading.value = false;
    return tasksLoaded;
  }

  async function save(agentId: string, input: ScheduledTaskInput, task?: ScheduledTask) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (mutationBusy.value) return false;
    const context = contextGeneration;
    saving.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(agentPath(
        task ? `/api/scheduled-tasks/${encodeURIComponent(task.id)}` : "/api/scheduled-tasks",
        normalizedAgentId
      ), {
        method: task ? "PUT" : "POST",
        body: JSON.stringify(task
          ? { ...normalizedInput(input), revision: task.revision }
          : normalizedInput(input))
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await loadTasks(normalizedAgentId, context)) return false;
      status.value = { kind: "success", message: task ? "定时任务已更新" : "定时任务已创建" };
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "定时任务保存失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) saving.value = false;
    }
  }

  async function setEnabled(agentId: string, task: ScheduledTask, enabled: boolean) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (mutationBusy.value) return false;
    const context = contextGeneration;
    togglingId.value = task.id;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(agentPath(
        `/api/scheduled-tasks/${encodeURIComponent(task.id)}`,
        normalizedAgentId
      ), {
        method: "PUT",
        body: JSON.stringify({ ...normalizedInput({ ...task, enabled }), revision: task.revision })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await loadTasks(normalizedAgentId, context)) return false;
      status.value = { kind: "success", message: enabled ? "定时任务已启用" : "定时任务已停用" };
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "定时任务状态更新失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) togglingId.value = "";
    }
  }

  async function remove(agentId: string, task: ScheduledTask) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (mutationBusy.value) return false;
    const context = contextGeneration;
    deletingId.value = task.id;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(agentPath(
        `/api/scheduled-tasks/${encodeURIComponent(task.id)}`,
        normalizedAgentId
      ), {
        method: "DELETE",
        body: JSON.stringify({ revision: task.revision })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await loadTasks(normalizedAgentId, context)) return false;
      status.value = { kind: "success", message: "定时任务已删除" };
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "定时任务删除失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) deletingId.value = "";
    }
  }

  function clearStatus() {
    status.value = { kind: "idle", message: "" };
  }

  function dispose() {
    contextGeneration += 1;
    taskController?.abort();
    conversationController?.abort();
  }

  async function loadTasks(agentId: string, context: number) {
    const generation = ++taskLoadGeneration;
    taskController?.abort();
    taskController = new AbortController();
    try {
      const payload = await apiRequest<ScheduledTasksResponse>(
        agentPath("/api/scheduled-tasks", agentId),
        { signal: taskController.signal }
      );
      if (!isCurrent(agentId, context) || generation !== taskLoadGeneration) return false;
      tasks.value = Array.isArray(payload.tasks) ? [...payload.tasks] : [];
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(agentId, context) || generation !== taskLoadGeneration) return false;
      status.value = { kind: "error", message: errorMessage(caught, "定时任务读取失败") };
      return false;
    }
  }

  async function loadConversations(agentId: string, context: number) {
    const generation = ++conversationLoadGeneration;
    conversationController?.abort();
    conversationController = new AbortController();
    try {
      const payload = await apiRequest<ScheduledTaskConversationResponse>(
        agentPath("/api/conversations", agentId),
        { signal: conversationController.signal }
      );
      if (!isCurrent(agentId, context) || generation !== conversationLoadGeneration) return false;
      conversations.value = Array.isArray(payload.conversations) ? [...payload.conversations] : [];
      return true;
    } catch (caught) {
      if (isAbort(caught) || !isCurrent(agentId, context) || generation !== conversationLoadGeneration) return false;
      conversations.value = [];
      return false;
    }
  }

  function activate(agentId: string) {
    if (activeAgentId === agentId) return;
    activeAgentId = agentId;
    contextGeneration += 1;
    loadGeneration += 1;
    taskLoadGeneration += 1;
    conversationLoadGeneration += 1;
    taskController?.abort();
    conversationController?.abort();
    tasks.value = [];
    conversations.value = [];
    loading.value = false;
    saving.value = false;
    deletingId.value = "";
    togglingId.value = "";
    status.value = { kind: "idle", message: "" };
  }

  function isCurrent(agentId: string, generation: number) {
    return activeAgentId === agentId && contextGeneration === generation;
  }

  return {
    tasks: shallowReadonly(tasks),
    conversations: shallowReadonly(conversations),
    loading: readonly(loading),
    saving: readonly(saving),
    deletingId: readonly(deletingId),
    togglingId: readonly(togglingId),
    mutationBusy: readonly(mutationBusy),
    status: readonly(status),
    load,
    save,
    setEnabled,
    remove,
    clearStatus,
    dispose
  };
}

function normalizedInput(input: ScheduledTaskInput): ScheduledTaskInput {
  return {
    name: input.name.trim(),
    enabled: input.enabled,
    context: input.context.trim(),
    schedule: input.schedule.kind === "cron"
      ? {
          kind: "cron",
          expression: input.schedule.expression.trim().replace(/\s+/g, " "),
          timezone: input.schedule.timezone.trim()
        }
      : { kind: "once", runAt: input.schedule.runAt },
    targets: input.targets.map((target) => ({
      conversationId: target.conversationId.trim(),
      mentionUserIds: [...new Set(target.mentionUserIds.map((id) => id.trim()).filter(Boolean))]
    }))
  };
}

function normalizeAgentId(agentId: string) {
  return agentId.trim() || "plana";
}

function agentPath(path: string, agentId: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}agentId=${encodeURIComponent(agentId)}`;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
