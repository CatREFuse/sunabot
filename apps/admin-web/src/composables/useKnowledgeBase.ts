import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type {
  KnowledgeSearchMatch,
  KnowledgeSearchResult,
  KnowledgeSnapshot
} from "../types/knowledge";

export function useKnowledgeBase() {
  const snapshot = shallowRef<KnowledgeSnapshot | null>(null);
  const matches = shallowRef<KnowledgeSearchMatch[]>([]);
  const searchActive = shallowRef(false);
  const loading = shallowRef(false);
  const searching = shallowRef(false);
  const mutating = shallowRef(false);
  const error = shallowRef("");
  let generation = 0;
  let controller: AbortController | undefined;
  let currentAgentId = "";

  async function load(agentId: string) {
    const context = beginContext(agentId);
    loading.value = true;
    try {
      const payload = await apiRequest<KnowledgeSnapshot>(endpoint("/api/knowledge", context.agentId), {
        signal: context.controller.signal
      });
      if (!isCurrent(context)) return false;
      snapshot.value = payload;
      error.value = "";
      return true;
    } catch (caught) {
      return handleFailure(caught, context, "知识库读取失败");
    } finally {
      if (isCurrent(context)) loading.value = false;
    }
  }

  async function reindex(agentId: string) {
    const context = beginContext(agentId);
    mutating.value = true;
    try {
      const payload = await apiRequest<KnowledgeSnapshot>(endpoint("/api/knowledge/reindex", context.agentId), {
        method: "POST",
        signal: context.controller.signal
      });
      if (!isCurrent(context)) return false;
      snapshot.value = payload;
      clearSearch();
      error.value = "";
      return true;
    } catch (caught) {
      return handleFailure(caught, context, "知识库扫描失败");
    } finally {
      if (isCurrent(context)) mutating.value = false;
    }
  }

  async function search(query: string, agentId: string, limit = 12) {
    const context = beginContext(agentId, false);
    searching.value = true;
    const path = endpoint("/api/knowledge/search", context.agentId, {
      q: query,
      limit: String(limit)
    });
    try {
      const payload = await apiRequest<KnowledgeSearchResult>(path, { signal: context.controller.signal });
      if (!isCurrent(context)) return false;
      matches.value = payload.matches;
      searchActive.value = true;
      error.value = payload.error ?? "";
      return payload.ok;
    } catch (caught) {
      return handleFailure(caught, context, "知识库检索失败");
    } finally {
      if (isCurrent(context)) searching.value = false;
    }
  }

  async function upload(input: { path: string; content: string }, agentId: string) {
    const context = beginContext(agentId, false);
    mutating.value = true;
    try {
      const payload = await apiRequest<{ snapshot: KnowledgeSnapshot }>(
        endpoint("/api/knowledge/documents", context.agentId),
        {
          method: "POST",
          body: JSON.stringify(input),
          signal: context.controller.signal
        }
      );
      if (!isCurrent(context)) return false;
      snapshot.value = payload.snapshot;
      clearSearch();
      error.value = "";
      return true;
    } catch (caught) {
      if (!isCurrent(context)) return false;
      throw caught;
    } finally {
      if (isCurrent(context)) mutating.value = false;
    }
  }

  async function remove(documentPath: string, agentId: string) {
    const context = beginContext(agentId, false);
    mutating.value = true;
    try {
      const payload = await apiRequest<{ snapshot: KnowledgeSnapshot }>(
        endpoint("/api/knowledge/documents", context.agentId),
        {
          method: "DELETE",
          body: JSON.stringify({ path: documentPath }),
          signal: context.controller.signal
        }
      );
      if (!isCurrent(context)) return false;
      snapshot.value = payload.snapshot;
      clearSearch();
      error.value = "";
      return true;
    } catch (caught) {
      return handleFailure(caught, context, "删除失败");
    } finally {
      if (isCurrent(context)) mutating.value = false;
    }
  }

  function clearSearch() {
    matches.value = [];
    searchActive.value = false;
  }

  function dispose() {
    generation += 1;
    controller?.abort();
    loading.value = false;
    searching.value = false;
    mutating.value = false;
  }

  function beginContext(agentId: string, clearOnAgentChange = true) {
    const normalizedAgentId = agentId.trim() || "plana";
    const nextGeneration = ++generation;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    if (clearOnAgentChange && currentAgentId && currentAgentId !== normalizedAgentId) {
      snapshot.value = null;
      clearSearch();
    }
    currentAgentId = normalizedAgentId;
    return { generation: nextGeneration, agentId: normalizedAgentId, controller: requestController };
  }

  function isCurrent(context: { generation: number }) {
    return context.generation === generation;
  }

  function handleFailure(caught: unknown, context: { generation: number }, fallback: string) {
    if (!isCurrent(context)) return false;
    if (caught instanceof DOMException && caught.name === "AbortError") return false;
    error.value = caught instanceof Error ? caught.message : fallback;
    return false;
  }

  return {
    snapshot: shallowReadonly(snapshot),
    matches: shallowReadonly(matches),
    searchActive: shallowReadonly(searchActive),
    loading: shallowReadonly(loading),
    searching: shallowReadonly(searching),
    mutating: shallowReadonly(mutating),
    error: shallowReadonly(error),
    load,
    reindex,
    search,
    upload,
    remove,
    clearSearch,
    dispose
  };
}

function endpoint(base: string, agentId: string, params: Record<string, string> = {}) {
  const search = new URLSearchParams({ agentId, ...params });
  return `${base}?${search.toString()}`;
}
