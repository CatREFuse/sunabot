import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import { memorySourceIds } from "../types";
import type { MemoryDocument, MemoryEntry, MemoryPayload, MemoryRecallPayload, MemorySource, MemorySourceId, MemoryWritePayload } from "../types";

const supportedSources = new Set<string>(memorySourceIds);

export function useMemory() {
  const sources = shallowRef<MemorySource[]>([]);
  const entries = shallowRef<MemoryEntry[]>([]);
  const document = shallowRef<MemoryDocument | null>(null);
  const matches = shallowRef<MemoryEntry[]>([]);
  const recallActive = shallowRef(false);
  const loading = shallowRef(false);
  const mutating = shallowRef(false);
  const error = shallowRef("");
  const activeSource = shallowRef<MemorySourceId>("working");
  let controller: AbortController | undefined;
  let requestAgentId = "";
  let contextGeneration = 0;

  async function load(source: MemorySourceId = activeSource.value, agentId?: string) {
    const normalizedAgentId = agentId?.trim() ?? "";
    const generation = ++contextGeneration;
    activeSource.value = source;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    if (requestAgentId && normalizedAgentId && requestAgentId !== normalizedAgentId) {
      entries.value = [];
      document.value = null;
      clearMatches();
    }
    requestAgentId = normalizedAgentId;
    loading.value = true;
    const agentQuery = normalizedAgentId ? `&agentId=${encodeURIComponent(normalizedAgentId)}` : "";
    try {
      const payload = await apiRequest<MemoryPayload>(`/api/memory?source=${encodeURIComponent(source)}${agentQuery}`, { signal: requestController.signal });
      if (generation !== contextGeneration) return false;
      sources.value = payload.sources.filter((item) => supportedSources.has(String(item.id)));
      entries.value = payload.entries.filter((item) => supportedSources.has(String(item.source)));
      document.value = source === "working" ? payload.document ?? null : null;
      error.value = "";
      return true;
    } catch (caught) {
      if (generation !== contextGeneration) return false;
      if (caught instanceof DOMException && caught.name === "AbortError") return false;
      error.value = caught instanceof Error ? caught.message : "记忆读取失败";
      return false;
    } finally {
      if (generation === contextGeneration) loading.value = false;
    }
  }

  async function recall(query: string, source: MemorySourceId, limit = 10) {
    loading.value = true;
    try {
      const payload = await apiRequest<MemoryRecallPayload>("/api/memory/recall", {
        method: "POST",
        body: JSON.stringify({ query, source, limit })
      });
      matches.value = payload.matches.filter((item) => supportedSources.has(String(item.source)));
      recallActive.value = true;
      error.value = payload.error ?? "";
    } finally {
      loading.value = false;
    }
  }

  async function create(payload: MemoryWritePayload) {
    mutating.value = true;
    try {
      await apiRequest("/api/memory", { method: "POST", body: JSON.stringify(payload) });
      clearMatches();
      await load(payload.source);
    } finally {
      mutating.value = false;
    }
  }

  async function update(payload: MemoryWritePayload & { id: string }) {
    mutating.value = true;
    try {
      await apiRequest("/api/memory", { method: "PUT", body: JSON.stringify(payload) });
      clearMatches();
      await load(payload.source);
    } finally {
      mutating.value = false;
    }
  }

  async function remove(entry: MemoryEntry) {
    mutating.value = true;
    try {
      await apiRequest("/api/memory", { method: "DELETE", body: JSON.stringify({ source: entry.source, id: entry.id }) });
      clearMatches();
      await load(entry.source);
    } finally {
      mutating.value = false;
    }
  }

  function clearMatches() {
    matches.value = [];
    recallActive.value = false;
  }
  function dispose() {
    contextGeneration += 1;
    controller?.abort();
    loading.value = false;
  }

  return { sources: shallowReadonly(sources), entries: shallowReadonly(entries), document: shallowReadonly(document), matches: shallowReadonly(matches), recallActive: shallowReadonly(recallActive), loading: shallowReadonly(loading), mutating: shallowReadonly(mutating), error: shallowReadonly(error), load, recall, create, update, remove, clearMatches, dispose };
}
