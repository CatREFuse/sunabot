<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { ConversationMessageStats, ModelCallStatsPayload } from "../../types";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";

const UNLABELED_MODEL = "__unlabeled__";

const props = withDefaults(defineProps<{
  stats: ModelCallStatsPayload | null;
  messages?: ConversationMessageStats;
  loading?: boolean;
  compact?: boolean;
  collapsible?: boolean;
}>(), {
  collapsible: true
});
const expanded = shallowRef(true);
const selectedModel = shallowRef("");
const activeStats = computed(() => props.stats?.models?.find((entry) => entry.model === selectedModel.value) ?? props.stats);

watch(() => props.stats?.models, (models) => {
  if (selectedModel.value && !models?.some((entry) => entry.model === selectedModel.value)) selectedModel.value = "";
});

const behaviorRows = computed(() => [
  { id: "reply", label: "回答", bucket: activeStats.value?.behavior.reply },
  { id: "orchestrator", label: "编排器", bucket: activeStats.value?.behavior.orchestrator },
  { id: "memory", label: "记忆压缩", bucket: activeStats.value?.memory.total },
  { id: "other", label: "其他", bucket: activeStats.value?.behavior.other }
]);
const memoryRows = computed(() => [
  { id: "working_long_term", label: "工作与长期记忆", bucket: activeStats.value?.memory.kinds.working_long_term },
  { id: "user_profile", label: "用户画像", bucket: activeStats.value?.memory.kinds.user_profile }
]);

const metric = (value?: number) => formatDashboardMetric(value ?? 0);
const exact = (value?: number) => formatExactNumber(value ?? 0);
const modelLabel = (model: string) => model === UNLABELED_MODEL ? "未标注模型" : model;
const detailId = `model-call-stats-${Math.random().toString(36).slice(2)}`;
</script>

<template>
  <section class="border-y border-line" aria-label="模型调用统计">
    <header class="flex flex-wrap items-end justify-between gap-3 px-4 py-3" :class="compact ? '' : 'md:px-6'">
      <div class="flex min-w-0 items-center gap-2">
        <button
          v-if="collapsible"
          class="icon-btn"
          type="button"
          :aria-expanded="expanded"
          :aria-controls="detailId"
          :aria-label="expanded ? '收起模型调用' : '展开模型调用'"
          @click="expanded = !expanded"
        >
          <i class="bx text-xl" :class="expanded ? 'bx-chevron-up' : 'bx-chevron-down'" aria-hidden="true"></i>
        </button>
        <h2 :class="compact ? 'text-base' : 'text-xl'" class="font-medium text-display">模型调用</h2>
      </div>
      <div class="flex min-w-0 flex-wrap items-center justify-end gap-3">
        <label v-if="stats?.models?.length" class="flex items-center gap-2 text-xs text-body">
          <span>模型</span>
          <select v-model="selectedModel" class="min-w-0 max-w-48 border-0 border-b border-line bg-transparent py-1 font-mono text-xs text-display outline-none focus:border-display" aria-label="筛选模型">
            <option value="">全部模型</option>
            <option v-for="entry in stats.models ?? []" :key="entry.model" :value="entry.model">{{ modelLabel(entry.model) }}</option>
          </select>
        </label>
        <p v-if="loading" class="font-mono text-[10px] text-mute">统计中</p>
        <p v-else class="font-mono text-[10px] text-mute">
          <span v-if="messages" :title="exact(messages.total)">{{ metric(messages.total) }} 条消息 · </span><span :title="exact(activeStats?.total.requests)">{{ metric(activeStats?.total.requests) }} 次</span> · <span :title="exact(activeStats?.total.total)">{{ metric(activeStats?.total.total) }} Token</span>
        </p>
      </div>
      <p v-if="messages" class="w-full font-mono text-[10px] text-mute">
        保留 {{ metric(messages.retained) }} · 可见 {{ metric(messages.visible) }} · 用户 {{ metric(messages.user) }} · 回答 {{ metric(messages.assistant) }} · 内部 {{ metric(messages.internal) }}
      </p>
    </header>

    <div v-show="expanded" :id="detailId">
      <div
        class="grid border-t border-line"
        :class="compact ? 'grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 xl:grid-cols-4'"
      >
        <div
          v-for="row in behaviorRows"
          :key="row.id"
          class="border-b border-line px-4 py-3"
          :class="compact
            ? '[&:nth-child(odd)]:border-r [&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0'
            : 'last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0'"
        >
          <p class="text-sm text-body">{{ row.label }}</p>
          <p class="mt-1 font-mono text-sm text-display" :title="exact(row.bucket?.total)">{{ metric(row.bucket?.total) }} <span class="text-[10px] text-mute">Token</span></p>
          <p class="mt-1 font-mono text-[10px] text-mute" :title="exact(row.bucket?.requests)">{{ metric(row.bucket?.requests) }} 次调用</p>
        </div>
      </div>

      <div class="grid grid-cols-2 border-t border-line">
        <div
          v-for="row in memoryRows"
          :key="row.id"
          class="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
        >
          <span class="text-xs text-body">{{ row.label }}</span>
          <span class="font-mono text-[10px] text-mute"><span :title="exact(row.bucket?.requests)">{{ metric(row.bucket?.requests) }} 次</span> · <span :title="exact(row.bucket?.total)">{{ metric(row.bucket?.total) }} Token</span></span>
        </div>
      </div>
    </div>
  </section>
</template>
