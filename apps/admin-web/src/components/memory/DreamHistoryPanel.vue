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

type DreamStateKind = "success" | "error" | "warning" | undefined;
type DreamHistoryDisplayItem = DreamHistoryItem & {
  statusLabel: string;
  statusKind: DreamStateKind;
  dateLabel: string;
  scheduledLabel: string;
  completedLabel: string;
  failedLabel: string;
  retryLabel: string;
  summaryLabel: string;
  failureHeadline: string;
  bodyText: string;
};

const historyExpanded = shallowRef(false);
const sortedItems = computed<DreamHistoryDisplayItem[]>(() => (
  sortByMemoryTime(
    props.items,
    props.sortField,
    props.sortDirection,
    (item) => ({
      createdAt: item.scheduledFor,
      updatedAt: item.completedAt ?? item.failedAt ?? item.scheduledFor
    })
  ).map((item) => presentHistoryItem(item))
));
const latestItem = computed(() => sortedItems.value[0]);
const historyItems = computed(() => sortedItems.value.slice(1));
const visibleHistory = computed(() => historyExpanded.value ? historyItems.value : historyItems.value.slice(0, 3));
const nextScheduleLabel = computed(() => formatDateTime(props.nextScheduledFor));

function presentHistoryItem(item: DreamHistoryItem): DreamHistoryDisplayItem {
  const failureHeadline = dreamFailureHeadline(item);
  return {
    ...item,
    statusLabel: statusLabel(item.status),
    statusKind: statusKind(item.status),
    dateLabel: dateLabel(item.date),
    scheduledLabel: formatDateTime(item.scheduledFor),
    completedLabel: formatDateTime(item.completedAt),
    failedLabel: formatDateTime(item.failedAt),
    retryLabel: formatDateTime(item.nextRetryAt),
    summaryLabel: summaryLabel(item),
    failureHeadline,
    bodyText: item.dreamText || failureHeadline || "梦境尚未生成"
  };
}

function statusLabel(status: DreamRunStatus): string {
  return ({
    pending: "等待中",
    running: "正在做梦",
    generated: "正在整理",
    completed: "已完成",
    failed: "失败"
  } satisfies Record<DreamRunStatus, string>)[status];
}

function statusKind(status: DreamRunStatus): DreamStateKind {
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
  return `工作记忆减少 ${item.summary.workingMemoryReduced} · 长期记忆新增 ${item.summary.longTermAdded}`;
}

function dreamFailureHeadline(item: DreamHistoryItem) {
  if (item.status !== "failed") return "";
  if (item.errorCode !== "DREAM_OUTPUT_CONTRACT_INVALID") return "梦境生成失败";
  const maximum = item.maxAttempts || 3;
  const attempt = Math.min(Math.max(item.attemptCount || 0, 1), maximum);
  if (attempt >= maximum && !item.nextRetryAt) {
    return `Dream 输出格式连续 ${maximum} 次未通过`;
  }
  if (item.nextRetryAt && attempt < maximum) {
    return `输出格式未通过 · 第 ${attempt}/${maximum} 次 · 等待重试`;
  }
  return "Dream 输出格式未通过";
}
</script>

<template>
  <section aria-labelledby="dream-history-title">
    <header class="flex min-w-0 flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <p class="field-label">最近运行</p>
        <div class="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 id="dream-history-title" class="text-3xl font-medium tracking-[-0.03em] text-display">
            {{ latestItem ? latestItem.statusLabel : "等待第一次梦境" }}
          </h2>
          <span v-if="latestItem" class="inline-state" :data-kind="latestItem.statusKind">{{ latestItem.dateLabel }}</span>
        </div>
        <p v-if="nextScheduleLabel" class="mt-3 font-mono text-[11px] text-mute">
          下次 <time :datetime="nextScheduledFor">{{ nextScheduleLabel }}</time><span v-if="timeZone"> · {{ timeZone }}</span>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span v-if="triggerStatus" class="inline-state" :data-kind="triggerStatusKind || undefined" role="status" aria-live="polite">{{ triggerStatus }}</span>
        <button class="btn btn-primary" type="button" :disabled="loading || triggering" @click="emit('trigger')">
          <i class="bx bx-moon" aria-hidden="true"></i>
          {{ triggering ? "做梦中" : "立即做梦" }}
        </button>
        <button class="icon-btn" type="button" :disabled="loading || triggering" aria-label="刷新梦境" @click="emit('refresh')">
          <i class="bx bx-refresh" :class="loading ? 'bx-spin' : ''" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <p v-if="error" class="inline-state mt-5" data-kind="error" role="alert">{{ error }}</p>

    <article v-if="latestItem" class="grid gap-8 border-b border-line py-8 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div class="min-w-0">
        <p v-if="latestItem.dreamText" class="max-w-3xl whitespace-pre-wrap text-base leading-8 text-ink">{{ latestItem.dreamText }}</p>
        <div v-else-if="latestItem.failureHeadline" class="max-w-3xl" role="status" aria-live="polite">
          <p class="text-sm font-medium text-display">{{ latestItem.failureHeadline }}</p>
          <p v-if="latestItem.errorText" class="mt-2 break-words text-xs leading-5 text-mute">{{ latestItem.errorText }}</p>
        </div>
        <p v-else class="text-sm text-mute">梦境尚未生成</p>
      </div>
      <dl class="grid content-start grid-cols-[max-content_1fr] gap-x-4 gap-y-3 text-xs">
        <dt class="text-mute">计划</dt>
        <dd class="text-right font-mono text-[11px] text-ink">{{ latestItem.scheduledLabel || "--" }}</dd>
        <template v-if="latestItem.completedLabel">
          <dt class="text-mute">完成</dt>
          <dd class="text-right font-mono text-[11px] text-ink">{{ latestItem.completedLabel }}</dd>
        </template>
        <template v-if="latestItem.failedLabel">
          <dt class="text-mute">失败</dt>
          <dd class="text-right font-mono text-[11px] text-ink">{{ latestItem.failedLabel }}</dd>
        </template>
        <template v-if="latestItem.retryLabel">
          <dt class="text-mute">重试</dt>
          <dd data-testid="dream-retry-time" class="text-right font-mono text-[11px] text-ink">{{ latestItem.retryLabel }}</dd>
        </template>
        <template v-if="latestItem.errorCode">
          <dt class="text-mute">错误</dt>
          <dd class="break-all text-right font-mono text-[11px] text-accent">{{ latestItem.errorCode }}</dd>
        </template>
        <template v-if="latestItem.summaryLabel">
          <dt class="text-mute">整理</dt>
          <dd class="text-right font-mono text-[11px] text-ink">{{ latestItem.summaryLabel }}</dd>
        </template>
      </dl>
    </article>

    <section v-if="historyItems.length" class="pt-8" aria-labelledby="dream-history-list-title">
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="field-label">历史</p>
          <h3 id="dream-history-list-title" class="mt-2 text-lg font-medium text-display">过往梦境</h3>
        </div>
        <button
          v-if="historyItems.length > 3"
          class="btn btn-ghost"
          type="button"
          :aria-expanded="historyExpanded"
          @click="historyExpanded = !historyExpanded"
        >
          {{ historyExpanded ? "收起" : `查看全部 ${historyItems.length} 条` }}
          <i class="bx" :class="historyExpanded ? 'bx-chevron-up' : 'bx-chevron-down'" aria-hidden="true"></i>
        </button>
      </div>
      <TransitionGroup name="memory-list" tag="ol" class="mt-4 border-t border-line" aria-label="梦境历史">
        <li v-for="item in visibleHistory" :key="item.id" class="grid gap-3 border-b border-line py-5 md:grid-cols-[140px_minmax(0,1fr)_max-content] md:gap-6">
          <div>
            <time class="font-mono text-xs text-display" :datetime="item.date">{{ item.dateLabel }}</time>
            <span class="inline-state mt-2 block" :data-kind="item.statusKind">{{ item.statusLabel }}</span>
          </div>
          <div class="min-w-0">
            <p class="line-clamp-2 text-sm leading-6 text-ink">{{ item.bodyText }}</p>
            <p v-if="item.errorCode" class="mt-1 break-all font-mono text-[10px] text-accent">{{ item.errorCode }}</p>
          </div>
          <span class="font-mono text-[11px] text-mute">{{ item.summaryLabel || item.retryLabel || item.completedLabel || item.scheduledLabel }}</span>
        </li>
      </TransitionGroup>
    </section>

    <p v-if="!latestItem && loading" class="py-16 text-center font-mono text-xs text-mute" role="status">[正在读取梦境]</p>
    <p v-else-if="!latestItem" class="py-16 text-center text-sm text-mute">还没有梦境</p>
  </section>
</template>

<style scoped>
.memory-list-enter-active,
.memory-list-leave-active {
  transition: opacity 180ms var(--motion-ease), transform 180ms var(--motion-ease);
}

.memory-list-enter-from,
.memory-list-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .memory-list-enter-active,
  .memory-list-leave-active {
    transition: none;
  }
}
</style>
