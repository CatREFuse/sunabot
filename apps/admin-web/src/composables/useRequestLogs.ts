import { readonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type {
  ConversationLogEntry,
  ModelCallStatsPayload,
  OneBotEventTrace,
  RequestLogBusinessNode,
  RequestLogMemoryTool
} from "../types";

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
  const node = shallowRef<RequestLogBusinessNode>("all");
  const memoryTool = shallowRef<RequestLogMemoryTool>("all");
  const page = shallowRef(1);
  const pageSize = shallowRef(50);
  const total = shallowRef(0);
  const pageCount = shallowRef(1);
  const loading = shallowRef(false);
  const error = shallowRef("");
  const stats = shallowRef<ModelCallStatsPayload | null>(null);
  let requestGeneration = 0;

  async function load(targetPage = page.value) {
    const generation = ++requestGeneration;
    loading.value = true;
    try {
      const statsRequest = apiRequest<ModelCallStatsPayload>("/api/model-call-stats");
      if (node.value === "onebot_heartbeat") {
        const [eventPayload, statsPayload] = await Promise.all([
          apiRequest<{ events: OneBotEventTrace[] }>("/api/onebot/events"),
          statsRequest
        ]);
        if (generation !== requestGeneration) return;
        events.value = eventPayload.events;
        logs.value = heartbeatLogs(eventPayload.events);
        page.value = 1;
        total.value = logs.value.length;
        pageCount.value = 1;
        stats.value = statsPayload;
      } else {
        const query = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize.value),
          node: node.value,
          memoryTool: memoryTool.value
        });
        const [logPayload, statsPayload] = await Promise.all([
          apiRequest<RequestLogPage>(`/api/request-logs?${query}`),
          statsRequest
        ]);
        if (generation !== requestGeneration) return;
        logs.value = logPayload.logs;
        page.value = logPayload.page;
        total.value = logPayload.total;
        pageCount.value = logPayload.pageCount;
        stats.value = statsPayload;
      }
      error.value = "";
    } catch (reason) {
      if (generation !== requestGeneration) return;
      error.value = reason instanceof Error ? reason.message : "日志读取失败";
    } finally {
      if (generation === requestGeneration) loading.value = false;
    }
  }

  function selectNode(next: RequestLogBusinessNode) {
    if (node.value === next) return;
    node.value = next;
    page.value = 1;
    void load(1);
  }

  function selectMemoryTool(next: RequestLogMemoryTool) {
    if (memoryTool.value === next) return;
    memoryTool.value = next;
    page.value = 1;
    void load(1);
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
    node: readonly(node),
    memoryTool: readonly(memoryTool),
    page: readonly(page),
    pageSize: readonly(pageSize),
    total: readonly(total),
    pageCount: readonly(pageCount),
    loading: readonly(loading),
    error: readonly(error),
    stats: readonly(stats),
    load,
    selectNode,
    selectMemoryTool,
    previous,
    next
  };
}

function heartbeatLogs(events: readonly OneBotEventTrace[]): ConversationLogEntry[] {
  return events
    .filter((event) => event.postType === "meta_event" && event.detailType === "heartbeat")
    .map((event, index) => ({
      id: `onebot-heartbeat:${event.receivedAt}:${event.selfId ?? ""}:${index}`,
      at: event.receivedAt,
      category: "onebot.event",
      action: "onebot.heartbeat",
      request: event,
      response: { received: true },
      metadata: {
        accountId: event.accountId,
        selfId: event.selfId,
        detailType: event.detailType
      },
      presentation: {
        businessNode: "onebot_heartbeat",
        businessNodes: ["onebot_heartbeat"],
        status: "success",
        attempt: 1,
        maxAttempts: 1,
        retryCount: 0,
        willRetry: false
      }
    }));
}
