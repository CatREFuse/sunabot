import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";

export type DreamRunStatus = "pending" | "running" | "generated" | "completed" | "failed";

export interface DreamHistoryItem {
  id: string;
  date: string;
  status: DreamRunStatus;
  attemptCount: number;
  maxAttempts: 3;
  dreamText?: string;
  scheduledFor: string;
  completedAt?: string;
  errorCode?: string;
  errorText?: string;
  nextRetryAt?: string;
  failedAt?: string;
  summary?: {
    workingMemoryReduced: number;
    longTermAdded: number;
  };
}

export interface DreamHistoryPayload {
  items: DreamHistoryItem[];
  timeZone: string;
  nextScheduledFor?: string;
}

export interface DreamTriggerPayload {
  ok: true;
  notificationQueued: true;
  run: DreamHistoryItem;
}

const DREAM_HISTORY_LIMIT = 30;

export function useDreams(initialAgentId: string) {
  const items = shallowRef<DreamHistoryItem[]>([]);
  const timeZone = shallowRef("");
  const nextScheduledFor = shallowRef("");
  const loading = shallowRef(false);
  const error = shallowRef("");
  const triggering = shallowRef(false);
  const triggerStatus = shallowRef("");
  const triggerStatusKind = shallowRef<"success" | "error" | "">("");
  let agentId = normalizeAgentId(initialAgentId);
  let controller: AbortController | undefined;
  let triggerController: AbortController | undefined;
  let contextGeneration = 0;

  async function load(nextAgentId: string) {
    const requestedAgentId = normalizeAgentId(nextAgentId);
    const generation = ++contextGeneration;
    const agentChanged = requestedAgentId !== agentId;
    agentId = requestedAgentId;
    controller?.abort();
    controller = new AbortController();
    if (agentChanged) {
      triggerController?.abort();
      triggerController = undefined;
      triggering.value = false;
      triggerStatus.value = "";
      triggerStatusKind.value = "";
      items.value = [];
      timeZone.value = "";
      nextScheduledFor.value = "";
    }
    loading.value = true;
    error.value = "";

    const query = new URLSearchParams({
      limit: String(DREAM_HISTORY_LIMIT),
      agentId: requestedAgentId
    });
    try {
      const payload = await apiRequest<DreamHistoryPayload>(`/api/memory/dreams?${query.toString()}`, {
        signal: controller.signal
      });
      if (generation !== contextGeneration || requestedAgentId !== agentId) return false;
      items.value = payload.items;
      timeZone.value = payload.timeZone;
      nextScheduledFor.value = payload.nextScheduledFor ?? "";
      return true;
    } catch (caught) {
      if (generation !== contextGeneration || requestedAgentId !== agentId) return false;
      if (caught instanceof DOMException && caught.name === "AbortError") return false;
      error.value = caught instanceof Error ? caught.message : "梦境读取失败";
      return false;
    } finally {
      if (generation === contextGeneration) loading.value = false;
    }
  }

  async function trigger(nextAgentId: string) {
    const requestedAgentId = normalizeAgentId(nextAgentId);
    if (requestedAgentId !== agentId || triggering.value) return false;
    triggerController?.abort();
    const activeController = new AbortController();
    triggerController = activeController;
    triggering.value = true;
    triggerStatus.value = "";
    triggerStatusKind.value = "";
    try {
      const query = new URLSearchParams({ agentId: requestedAgentId });
      const payload = await apiRequest<DreamTriggerPayload>(`/api/memory/dreams/trigger?${query.toString()}`, {
        method: "POST",
        signal: activeController.signal
      });
      if (activeController.signal.aborted || requestedAgentId !== agentId) return false;
      await load(requestedAgentId);
      const completed = payload.run.status === "completed";
      triggerStatus.value = completed ? "梦境已完成" : "梦境生成失败";
      triggerStatusKind.value = completed ? "success" : "error";
      return completed;
    } catch (caught) {
      if (activeController.signal.aborted || requestedAgentId !== agentId) return false;
      triggerStatus.value = caught instanceof Error ? caught.message : "Dream 触发失败";
      triggerStatusKind.value = "error";
      return false;
    } finally {
      if (triggerController === activeController) triggerController = undefined;
      if (requestedAgentId === agentId) triggering.value = false;
    }
  }

  function dispose() {
    contextGeneration += 1;
    controller?.abort();
    controller = undefined;
    triggerController?.abort();
    triggerController = undefined;
    loading.value = false;
    triggering.value = false;
  }

  return {
    items: shallowReadonly(items),
    timeZone: shallowReadonly(timeZone),
    nextScheduledFor: shallowReadonly(nextScheduledFor),
    loading: shallowReadonly(loading),
    error: shallowReadonly(error),
    triggering: shallowReadonly(triggering),
    triggerStatus: shallowReadonly(triggerStatus),
    triggerStatusKind: shallowReadonly(triggerStatusKind),
    load,
    trigger,
    dispose
  };
}

function normalizeAgentId(value: string) {
  return value.trim() || "plana";
}
