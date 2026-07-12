<script setup lang="ts">
import { computed } from "vue";
import type { ConversationMessageStats, ModelCallStatsPayload } from "../../types";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";

const props = defineProps<{
  stats: ModelCallStatsPayload | null;
  messages?: ConversationMessageStats;
  loading?: boolean;
  compact?: boolean;
}>();

const behaviorRows = computed(() => [
  { id: "reply", label: "回答", bucket: props.stats?.behavior.reply },
  { id: "orchestrator", label: "编排器", bucket: props.stats?.behavior.orchestrator },
  { id: "memory", label: "记忆压缩", bucket: props.stats?.memory.total },
  { id: "other", label: "其他", bucket: props.stats?.behavior.other }
]);
const memoryRows = computed(() => [
  { id: "working_long_term", label: "工作与长期记忆", bucket: props.stats?.memory.kinds.working_long_term },
  { id: "user_profile", label: "用户画像", bucket: props.stats?.memory.kinds.user_profile }
]);

const metric = (value?: number) => formatDashboardMetric(value ?? 0);
const exact = (value?: number) => formatExactNumber(value ?? 0);
</script>

<template>
  <section class="border-y border-line" aria-label="模型调用统计">
    <header class="flex flex-wrap items-end justify-between gap-3 px-4 py-3" :class="compact ? '' : 'md:px-6'">
      <div>
        <h2 :class="compact ? 'text-base' : 'text-xl'" class="font-medium text-display">模型调用</h2>
      </div>
      <p v-if="loading" class="font-mono text-[10px] text-mute">统计中</p>
      <p v-else class="font-mono text-[10px] text-mute">
        <span v-if="messages" :title="exact(messages.total)">{{ metric(messages.total) }} 条消息 · </span><span :title="exact(stats?.total.requests)">{{ metric(stats?.total.requests) }} 次</span> · <span :title="exact(stats?.total.total)">{{ metric(stats?.total.total) }} Token</span>
      </p>
      <p v-if="messages" class="w-full font-mono text-[10px] text-mute">
        保留 {{ metric(messages.retained) }} · 可见 {{ metric(messages.visible) }} · 用户 {{ metric(messages.user) }} · 回答 {{ metric(messages.assistant) }} · 内部 {{ metric(messages.internal) }}
      </p>
    </header>

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
  </section>
</template>
