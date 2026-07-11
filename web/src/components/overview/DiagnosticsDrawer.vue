<script setup lang="ts">
import { RefreshCw, X } from "lucide-vue-next";
import { reactive, shallowRef, watch } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import { formatFullDateTime } from "../../utils/format";
import type { ConversationLogEntry, OneBotEventTrace, SunaTool } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

type DiagnosticTab = "tools" | "logs" | "events";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const tabs: Array<{ id: DiagnosticTab; label: string }> = [
  { id: "tools", label: "工具" },
  { id: "logs", label: "请求日志" },
  { id: "events", label: "OneBot 事件" }
];
const active = shallowRef<DiagnosticTab>("tools");
const tools = shallowRef<SunaTool[]>([]);
const logs = shallowRef<ConversationLogEntry[]>([]);
const events = shallowRef<OneBotEventTrace[]>([]);
const logPath = shallowRef("");
const loaded = reactive<Record<DiagnosticTab, boolean>>({ tools: false, logs: false, events: false });
const loading = reactive<Record<DiagnosticTab, boolean>>({ tools: false, logs: false, events: false });
const errors = reactive<Record<DiagnosticTab, string>>({ tools: "", logs: "", events: "" });
const requestIds = reactive<Record<DiagnosticTab, number>>({ tools: 0, logs: 0, events: 0 });

watch(
  [() => props.open, active],
  ([open, tab]) => {
    if (open) void load(tab);
  },
  { immediate: true }
);

async function load(tab: DiagnosticTab = active.value, force = false) {
  if (loaded[tab] && !force) return;
  const requestId = ++requestIds[tab];
  loading[tab] = true;
  errors[tab] = "";
  try {
    if (tab === "tools") {
      const payload = await apiRequest<{ tools: SunaTool[] }>("/api/tools");
      if (requestId === requestIds[tab]) tools.value = payload.tools;
    } else if (tab === "logs") {
      const payload = await apiRequest<{ filePath?: string; logs: ConversationLogEntry[] }>("/api/request-logs?limit=100");
      if (requestId === requestIds[tab]) {
        logs.value = payload.logs;
        logPath.value = payload.filePath ?? "";
      }
    } else {
      const payload = await apiRequest<{ events: OneBotEventTrace[] }>("/api/onebot/events");
      if (requestId === requestIds[tab]) events.value = payload.events;
    }
    if (requestId === requestIds[tab]) loaded[tab] = true;
  } catch (error) {
    if (requestId === requestIds[tab]) errors[tab] = error instanceof Error ? error.message : "读取失败";
  } finally {
    if (requestId === requestIds[tab]) loading[tab] = false;
  }
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function eventTitle(event: OneBotEventTrace) {
  return [event.postType, event.messageType, event.detailType].filter(Boolean).join(" · ") || "OneBot";
}
</script>

<template>
  <DialogOverlay :open="open" placement="right" :z-index="60" labelledby="diagnostics-title" @close="emit('close')">
    <aside class="flex h-full w-full min-w-0 flex-col border-l border-visible bg-panel sm:max-w-2xl">
      <header class="flex min-h-20 items-center justify-between gap-4 border-b border-line px-4 md:px-6">
        <div><p class="page-kicker">DIAGNOSTICS</p><h2 id="diagnostics-title" class="mt-1 text-xl font-medium text-display">诊断</h2></div>
        <div class="flex items-center gap-2">
          <button class="icon-btn" type="button" :disabled="loading[active]" aria-label="刷新诊断" @click="load(active, true)"><RefreshCw :size="18" :stroke-width="1.5" /></button>
          <button class="icon-btn" type="button" aria-label="关闭诊断" @click="emit('close')"><X :size="19" :stroke-width="1.5" /></button>
        </div>
      </header>

      <nav class="grid grid-cols-3 border-b border-line px-2 sm:px-4" aria-label="诊断分类">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="min-h-12 border-b-2 border-transparent px-2 font-mono text-[10px] text-mute"
          :class="active === tab.id ? '!border-display !text-display' : ''"
          type="button"
          @click="active = tab.id"
        >{{ tab.label }}</button>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] md:px-6 md:pb-6">
        <p v-if="loading[active]" class="py-12 text-center font-mono text-xs text-mute">[LOADING...]</p>
        <p v-else-if="errors[active]" class="py-5 font-mono text-xs text-accent">[ERROR: {{ errors[active] }}]</p>

        <section v-else-if="active === 'tools'" aria-label="工具列表">
          <article v-for="tool in tools" :key="tool.name" class="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-line py-5">
            <div class="min-w-0"><strong class="text-sm font-medium text-display">{{ tool.title }}</strong><p class="mt-2 font-mono text-[10px] text-disabled">{{ tool.name }}</p></div>
            <span class="font-mono text-[10px]" :class="tool.enabled ? 'text-success' : 'text-mute'">{{ tool.enabled ? "[ENABLED]" : "[DISABLED]" }}</span>
          </article>
          <div v-if="!tools.length" class="empty-state"><div><strong>没有工具</strong></div></div>
        </section>

        <section v-else-if="active === 'logs'" aria-label="请求日志列表">
          <p v-if="logPath" class="truncate border-b border-line py-3 font-mono text-[10px] text-disabled">{{ logPath }}</p>
          <article v-for="log in logs" :key="log.id" class="border-b border-line py-5">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-2"><strong class="text-sm font-medium text-display">{{ log.category }} · {{ log.action }}</strong><time class="font-mono text-[10px] text-disabled">{{ formatFullDateTime(log.at) }}</time></div>
            <p v-if="log.providerId || log.model" class="mt-2 font-mono text-[10px] text-mute">{{ [log.providerId, log.model].filter(Boolean).join(" · ") }}</p>
            <details class="mt-3"><summary class="font-mono text-[10px] uppercase text-mute">详情</summary><pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-page p-3 font-mono text-[10px] text-ink">{{ json(log) }}</pre></details>
          </article>
          <div v-if="!logs.length" class="empty-state"><div><strong>没有请求日志</strong></div></div>
        </section>

        <section v-else aria-label="OneBot 事件列表">
          <article v-for="(event, index) in events" :key="`${event.receivedAt}-${event.messageId ?? index}`" class="border-b border-line py-5">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-2"><strong class="text-sm font-medium text-display">{{ eventTitle(event) }}</strong><time class="font-mono text-[10px] text-disabled">{{ formatFullDateTime(event.receivedAt) }}</time></div>
            <p v-if="event.text" class="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-ink">{{ event.text }}</p>
            <p v-if="event.userId || event.groupId" class="mt-2 font-mono text-[10px] text-mute">{{ event.groupId ? `GROUP ${event.groupId}` : `USER ${event.userId}` }}</p>
            <details class="mt-3"><summary class="font-mono text-[10px] uppercase text-mute">详情</summary><pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-page p-3 font-mono text-[10px] text-ink">{{ json(event) }}</pre></details>
          </article>
          <div v-if="!events.length" class="empty-state"><div><strong>没有 OneBot 事件</strong></div></div>
        </section>
      </div>
    </aside>
  </DialogOverlay>
</template>
