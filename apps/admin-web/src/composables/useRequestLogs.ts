import { readonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type { ConversationLogEntry, ModelCallStatsPayload, OneBotEventTrace } from "../types";

interface RequestLogPage {
  logs: ConversationLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export function useRequestLogs() {
  const logs = shallowRef<ConversationLogEntry[]>([]);
  const events = shallowRef<OneBotEventTrace[]>([]);
  const page = shallowRef(1);
  const pageSize = shallowRef(50);
  const total = shallowRef(0);
  const pageCount = shallowRef(1);
  const loading = shallowRef(false);
  const error = shallowRef("");
  const stats = shallowRef<ModelCallStatsPayload | null>(null);

  async function load(targetPage = page.value) {
    loading.value = true;
    try {
      const [logPayload, eventPayload, statsPayload] = await Promise.all([
        apiRequest<RequestLogPage>(`/api/request-logs?page=${targetPage}&pageSize=${pageSize.value}`),
        targetPage === 1
          ? apiRequest<{ events: OneBotEventTrace[] }>("/api/onebot/events")
          : Promise.resolve({ events: events.value }),
        apiRequest<ModelCallStatsPayload>("/api/model-call-stats")
      ]);
      logs.value = logPayload.logs;
      events.value = eventPayload.events;
      page.value = logPayload.page;
      total.value = logPayload.total;
      pageCount.value = logPayload.pageCount;
      stats.value = statsPayload;
      error.value = "";
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "日志读取失败";
    } finally {
      loading.value = false;
    }
  }

  function previous() {
    if (page.value > 1) void load(page.value - 1);
  }

  function next() {
    if (page.value < pageCount.value) void load(page.value + 1);
  }

  return {
    logs: readonly(logs),
    events: readonly(events),
    page: readonly(page),
    pageSize: readonly(pageSize),
    total: readonly(total),
    pageCount: readonly(pageCount),
    loading: readonly(loading),
    error: readonly(error),
    stats: readonly(stats),
    load,
    previous,
    next
  };
}
