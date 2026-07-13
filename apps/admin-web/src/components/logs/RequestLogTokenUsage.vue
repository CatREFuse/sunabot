<script setup lang="ts">
import { computed } from "vue";
import type { TokenUsageBreakdown } from "../../types";
import { formatDashboardMetric, formatExactNumber, formatPercent } from "../../utils/numberFormat";

interface UsageMetric {
  id: "total" | "input" | "output" | "cached" | "rate";
  label: string;
  icon: string;
  display: string;
  detail: string;
  tone: "neutral" | "interactive" | "success" | "warning";
}

const props = defineProps<{ usage: TokenUsageBreakdown }>();
const metrics = computed<UsageMetric[]>(() => [
  { id: "total", label: "总量", icon: "bx-bolt-circle", display: formatDashboardMetric(props.usage.total), detail: `${formatExactNumber(props.usage.total)} Token`, tone: "neutral" },
  { id: "input", label: "输入", icon: "bx-log-in-circle", display: formatDashboardMetric(props.usage.input), detail: `${formatExactNumber(props.usage.input)} Token`, tone: "interactive" },
  { id: "output", label: "输出", icon: "bx-log-out-circle", display: formatDashboardMetric(props.usage.output), detail: `${formatExactNumber(props.usage.output)} Token`, tone: "success" },
  { id: "cached", label: "缓存输入", icon: "bx-data", display: formatDashboardMetric(props.usage.cachedInput), detail: `${formatExactNumber(props.usage.cachedInput)} Token`, tone: "warning" },
  {
    id: "rate",
    label: "缓存率",
    icon: "bx-trending-up",
    display: formatPercent(props.usage.cacheRate),
    detail: props.usage.cacheRate == null ? "--" : `${formatExactNumber(props.usage.cachedInput)} / ${formatExactNumber(props.usage.input)}`,
    tone: "success"
  }
]);
</script>

<template>
  <dl class="request-usage" aria-label="Token 用量">
    <div v-for="metric in metrics" :key="metric.id" class="request-usage__item" :data-metric="metric.id" :data-tone="metric.tone">
      <dt><i class="bx" :class="metric.icon" aria-hidden="true"></i>{{ metric.label }}</dt>
      <dd :title="metric.detail">{{ metric.display }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.request-usage { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 14px; border-block: 1px solid rgb(var(--color-line)); }
.request-usage__item { min-width: 0; border-bottom: 1px solid rgb(var(--color-line)); padding: 10px 0; }
.request-usage__item:first-child { grid-column: 1 / -1; }
.request-usage__item:nth-child(even) { padding-right: 12px; }
.request-usage__item:nth-child(odd):not(:first-child) { border-left: 1px solid rgb(var(--color-line)); padding-left: 12px; }
.request-usage__item:nth-last-child(-n+2) { border-bottom: 0; }
.request-usage dt { display: flex; align-items: center; gap: 5px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.request-usage__item[data-tone="neutral"] dt i { color: rgb(var(--color-mute)); }
.request-usage__item[data-tone="interactive"] dt i { color: rgb(var(--color-interactive)); }
.request-usage__item[data-tone="success"] dt i { color: rgb(var(--color-success)); }
.request-usage__item[data-tone="warning"] dt i { color: rgb(var(--color-warning)); }
.request-usage dd { margin-top: 6px; overflow-wrap: anywhere; color: rgb(var(--color-display)); font-family: "Space Mono", monospace; font-size: 18px; font-weight: 700; line-height: 1; letter-spacing: -.03em; }
@media (min-width: 640px) {
  .request-usage { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .request-usage__item, .request-usage__item:first-child { grid-column: auto; border-bottom: 0; }
  .request-usage__item:nth-child(odd):not(:first-child), .request-usage__item:nth-child(even) { padding-right: 12px; padding-left: 12px; }
  .request-usage__item:first-child { padding-left: 0; }
  .request-usage__item + .request-usage__item { border-left: 1px solid rgb(var(--color-line)); }
}
</style>
