import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import { memorySourceIds } from "../types";
import type { MemoryEntry, MemoryPayload, MemoryRecallPayload, MemorySource, MemorySourceId, MemoryWritePayload } from "../types";

const supportedSources = new Set<string>(memorySourceIds);

export function useMemory() {
  const sources = shallowRef<MemorySource[]>([]);
  const entries = shallowRef<MemoryEntry[]>([]);
  const matches = shallowRef<MemoryEntry[]>([]);
  const recallActive = shallowRef(false);
  const loading = shallowRef(false);
  const mutating = shallowRef(false);
  const error = shallowRef("");
  let controller: AbortController | undefined;

  async function load(source: MemorySourceId | "all" = "all") {
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    try {
      const query = source === "all" ? "" : `?source=${encodeURIComponent(source)}`;
      const payload = await apiRequest<MemoryPayload>(`/api/memory${query}`, { signal: controller.signal });
      sources.value = payload.sources.filter((item) => supportedSources.has(String(item.id)));
      entries.value = payload.entries.filter((item) => supportedSources.has(String(item.source)));
      error.value = "";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      error.value = caught instanceof Error ? caught.message : "记忆读取失败";
    } finally {
      loading.value = false;
    }
  }

  async function recall(query: string, source: MemorySourceId | "all", limit = 10) {
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
      await load();
    } finally {
      mutating.value = false;
    }
  }

  async function update(payload: MemoryWritePayload & { id: string }) {
    mutating.value = true;
    try {
      await apiRequest("/api/memory", { method: "PUT", body: JSON.stringify(payload) });
      clearMatches();
      await load();
    } finally {
      mutating.value = false;
    }
  }

  async function remove(entry: MemoryEntry) {
    mutating.value = true;
    try {
      await apiRequest("/api/memory", { method: "DELETE", body: JSON.stringify({ source: entry.source, id: entry.id }) });
      clearMatches();
      await load();
    } finally {
      mutating.value = false;
    }
  }

  function clearMatches() {
    matches.value = [];
    recallActive.value = false;
  }
  function dispose() { controller?.abort(); }

  return { sources: shallowReadonly(sources), entries: shallowReadonly(entries), matches: shallowReadonly(matches), recallActive: shallowReadonly(recallActive), loading: shallowReadonly(loading), mutating: shallowReadonly(mutating), error: shallowReadonly(error), load, recall, create, update, remove, clearMatches, dispose };
}
