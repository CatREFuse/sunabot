import { shallowReadonly, shallowRef } from "vue";
import type { MemoryOperationLogEntry, MemoryOperationLogPayload } from "../types";
import { apiRequest } from "./useAdminApi";

const PAGE_SIZE = 50;

export function useMemoryOperationLogs() {
  const logs = shallowRef<MemoryOperationLogEntry[]>([]);
  const page = shallowRef(1);
  const total = shallowRef(0);
  const pageCount = shallowRef(1);
  const loading = shallowRef(false);
  const error = shallowRef("");
  let activeAgentId = "";
  let controller: AbortController | undefined;
  let generation = 0;

  async function load(agentId: string, targetPage = page.value) {
    const normalizedAgentId = agentId.trim();
    const currentGeneration = ++generation;
    controller?.abort();
    controller = new AbortController();
    if (activeAgentId && activeAgentId !== normalizedAgentId) resetState();
    activeAgentId = normalizedAgentId;
    loading.value = true;
    const agentQuery = normalizedAgentId ? `&agentId=${encodeURIComponent(normalizedAgentId)}` : "";
    try {
      const payload = await apiRequest<MemoryOperationLogPayload>(
        `/api/memory/operations?page=${targetPage}&pageSize=${PAGE_SIZE}${agentQuery}`,
        { signal: controller.signal }
      );
      if (currentGeneration !== generation) return false;
      logs.value = payload.logs;
      page.value = payload.page;
      total.value = payload.total;
      pageCount.value = payload.pageCount;
      error.value = "";
      return true;
    } catch (caught) {
      if (currentGeneration !== generation) return false;
      if (caught instanceof DOMException && caught.name === "AbortError") return false;
      error.value = caught instanceof Error ? caught.message : "记忆操作日志读取失败";
      return false;
    } finally {
      if (currentGeneration === generation) loading.value = false;
    }
  }

  function reset() {
    generation += 1;
    controller?.abort();
    activeAgentId = "";
    resetState();
  }

  function resetState() {
    logs.value = [];
    page.value = 1;
    total.value = 0;
    pageCount.value = 1;
    loading.value = false;
    error.value = "";
  }

  return {
    logs: shallowReadonly(logs),
    page: shallowReadonly(page),
    pageSize: PAGE_SIZE,
    total: shallowReadonly(total),
    pageCount: shallowReadonly(pageCount),
    loading: shallowReadonly(loading),
    error: shallowReadonly(error),
    load,
    reset,
    dispose: reset
  };
}
