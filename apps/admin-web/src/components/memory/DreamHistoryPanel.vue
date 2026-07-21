<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { DreamHistoryItem, DreamRunStatus } from "../../composables/useDreams";
import { sortByMemoryTime, type MemorySortDirection, type MemorySortField } from "../../utils/memorySort";

const props = defineProps<{
  items: readonly DreamHistoryItem[];
  loading: boolean;
  error: string;
  timeZone: string;
  nextScheduledFor?: string;
  sortField: MemorySortField;
  sortDirection: MemorySortDirection;
  triggering: boolean;
  triggerStatus: string;
  triggerStatusKind: "success" | "error" | "";
}>();
const emit = defineEmits<{ refresh: []; trigger: [] }>();

const historyExpanded = shallowRef(false);
const sortedItems = computed(() => sortByMemoryTime(
  props.items,
  props.sortField,
  props.sortDirection,
  (item) => ({
    createdAt: item.scheduledFor,
    updatedAt: item.completedAt ?? item.scheduledFor
  })
));
const historyItems = computed(() => sortedItems.value.slice(1));
const visibleItems = computed(() => {
  const first = sortedItems.value[0];
  if (!first) return [];
  return historyExpanded.value ? [first, ...historyItems.value] : [first];
});
const nextScheduleLabel = computed(() => formatDateTime(props.nextScheduledFor));

function statusLabel(status: DreamRunStatus) {
  return ({
    pending: "等待中",
    running: "正在做梦",
    generated: "正在整理",
    completed: "已完成",
    failed: "失败"
  } satisfies Record<DreamRunStatus, string>)[status];
}

function statusKind(status: DreamRunStatus) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running" || status === "generated") return "warning";
  return undefined;
}

function dateLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}

function formatDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  };
  if (props.timeZone) options.timeZone = props.timeZone;
  try {
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  }
}

function summaryLabel(item: DreamHistoryItem) {
  if (!item.summary) return "";
  return `合并 ${item.summary.merged} · 归档 ${item.summary.archived} · 转存 ${item.summary.promoted}`;
}
</script>

<template>
  <section class="mt-8 py-2" aria-labelledby="dream-history-title">
    <header class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="dream-history-title" class="section-title">梦境</h2>
          <span v-if="timeZone" class="font-mono text-[10px] text-mute">{{ timeZone }}</span>
        </div>
        <p v-if="nextScheduleLabel" class="mt-1 font-mono text-[10px] text-mute">
          下次做梦 <time :datetime="nextScheduledFor">{{ nextScheduleLabel }}</time>
        </p>
      </div>
      <div class="flex self-end items-center gap-2 sm:self-auto">
        <span v-if="triggerStatus" class="inline-state" :data-kind="triggerStatusKind || undefined" role="status">{{ triggerStatus }}</span>
        <button class="btn btn-primary" type="button" :disabled="loading || triggering" @click="emit('trigger')">
          <i class="bx bx-moon" aria-hidden="true"></i>
          {{ triggering ? "做梦中" : "立即做梦" }}
        </button>
        <button class="icon-btn" type="button" :disabled="loading || triggering" aria-label="刷新梦境" @click="emit('refresh')">
          <i class="bx bx-refresh" :class="loading ? 'bx-spin' : ''" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <p v-if="error" class="inline-state mt-4" data-kind="error" role="alert">{{ error }}</p>

    <div v-if="visibleItems.length" class="mt-5 space-y-6">
      <article v-for="item in visibleItems" :key="item.id" class="grid gap-3 py-2 md:grid-cols-[152px_minmax(0,1fr)] md:gap-6">
        <div class="flex min-w-0 items-center justify-between gap-3 md:block">
          <time class="font-mono text-xs text-display" :datetime="item.date">{{ dateLabel(item.date) }}</time>
          <span class="inline-state md:mt-2 md:block" :data-kind="statusKind(item.status)">{{ statusLabel(item.status) }}</span>
        </div>
        <div class="min-w-0">
          <p v-if="item.dreamText" class="whitespace-pre-wrap text-sm leading-7 text-ink">{{ item.dreamText }}</p>
          <p v-else class="text-sm text-mute">{{ item.status === "failed" ? "梦境生成失败" : "梦境尚未生成" }}</p>
          <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-mute">
            <span>计划 <time :datetime="item.scheduledFor">{{ formatDateTime(item.scheduledFor) || "--" }}</time></span>
            <span v-if="item.completedAt">完成 <time :datetime="item.completedAt">{{ formatDateTime(item.completedAt) || "--" }}</time></span>
            <span v-if="summaryLabel(item)">{{ summaryLabel(item) }}</span>
            <span v-if="item.personalityChanged" class="text-success">人格已微调</span>
          </div>
        </div>
      </article>
    </div>

    <p v-else-if="loading" class="mt-5 font-mono text-xs text-mute" role="status">正在读取梦境</p>
    <p v-else class="mt-5 text-sm text-mute">还没有梦境</p>

    <button
      v-if="historyItems.length"
      class="btn btn-ghost mt-4"
      type="button"
      :aria-expanded="historyExpanded"
      @click="historyExpanded = !historyExpanded"
    >
      <i class="bx" :class="historyExpanded ? 'bx-chevron-up' : 'bx-chevron-down'" aria-hidden="true"></i>
      {{ historyExpanded ? "收起历史" : `展开 ${historyItems.length} 条历史` }}
    </button>
  </section>
</template>
