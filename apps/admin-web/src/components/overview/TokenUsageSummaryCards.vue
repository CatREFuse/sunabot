<script setup lang="ts">
import { computed } from "vue";
import type { TokenUsageBucket } from "../../types";
import { formatDashboardMetric, formatExactNumber, formatPercent } from "../../utils/numberFormat";

interface SummaryMetric {
  id: "input" | "output" | "cached" | "rate" | "requests";
  label: string;
  icon: string;
  display: string;
  exact: string;
  tone: "interactive" | "success" | "warning" | "neutral";
}

const props = defineProps<{ usage: TokenUsageBucket | null }>();
const metrics = computed<SummaryMetric[]>(() => {
  const input = props.usage?.input ?? 0;
  const output = props.usage?.output ?? 0;
  const cachedInput = props.usage?.cachedInput ?? 0;
  const requests = props.usage?.requests ?? 0;
  const cacheRate = props.usage?.cacheRate ?? null;
  return [
    { id: "input", label: "输入", icon: "bx-log-in-circle", display: formatDashboardMetric(input), exact: formatExactNumber(input), tone: "interactive" },
    { id: "output", label: "输出", icon: "bx-log-out-circle", display: formatDashboardMetric(output), exact: formatExactNumber(output), tone: "success" },
    { id: "cached", label: "缓存输入", icon: "bx-data", display: formatDashboardMetric(cachedInput), exact: formatExactNumber(cachedInput), tone: "warning" },
    {
      id: "rate",
      label: "缓存率",
      icon: "bx-trending-up",
      display: formatPercent(cacheRate),
      exact: "",
      tone: "success"
    },
    { id: "requests", label: "请求", icon: "bx-transfer", display: formatDashboardMetric(requests), exact: `${formatExactNumber(requests)} 次`, tone: "neutral" }
  ];
});
</script>

<template>
  <section class="usage-summary" aria-label="今日 Token 统计">
    <article class="token-card token-card--hero">
      <span class="token-card__label"><i class="bx bx-bolt-circle" aria-hidden="true"></i>今日总量</span>
      <strong :title="formatExactNumber(usage?.total)">{{ formatDashboardMetric(usage?.total) }}</strong>
      <span class="token-card__exact">{{ formatExactNumber(usage?.total) }} TOKEN</span>
      <i class="bx bx-line-chart token-card__watermark" aria-hidden="true"></i>
    </article>

    <article
      v-for="metric in metrics"
      :key="metric.id"
      class="token-card token-card--metric"
      :class="metric.id === 'requests' ? 'token-card--request' : ''"
      :data-tone="metric.tone"
    >
      <span class="token-card__icon"><i class="bx" :class="metric.icon" aria-hidden="true"></i></span>
      <span class="token-card__label">{{ metric.label }}</span>
      <strong :title="metric.exact || metric.display">{{ metric.display }}</strong>
      <span v-if="metric.exact" class="token-card__exact">{{ metric.exact }}</span>
    </article>
  </section>
</template>

<style scoped>
.usage-summary { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.token-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); padding: 16px; }
.token-card__label { display: flex; align-items: center; gap: 7px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.token-card strong { display: block; margin-top: 16px; color: rgb(var(--color-display)); font-family: "Doto", "Space Mono", monospace; font-size: 36px; font-weight: 700; line-height: .92; letter-spacing: -.035em; }
.token-card__exact { display: block; margin-top: 8px; overflow-wrap: anywhere; color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 9px; }
.token-card--hero { grid-column: 1 / -1; min-height: 184px; padding: 20px; background: rgb(var(--color-display)); color: rgb(var(--color-page)); }
.token-card--hero .token-card__label, .token-card--hero .token-card__exact { color: rgb(var(--color-page) / .65); }
.token-card--hero strong { margin-top: 24px; color: rgb(var(--color-page)); font-size: clamp(44px, 8vw, 64px); }
.token-card__watermark { position: absolute; right: 16px; bottom: 10px; color: rgb(var(--color-page) / .12); font-size: 88px; }
.token-card--metric { min-height: 140px; }
.token-card--request { grid-column: 1 / -1; min-height: 112px; }
.token-card__icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; background: rgb(var(--color-raised)); color: rgb(var(--color-mute)); font-size: 18px; }
.token-card--metric[data-tone="interactive"] .token-card__icon { color: rgb(var(--color-interactive)); }
.token-card--metric[data-tone="success"] .token-card__icon { color: rgb(var(--color-success)); }
.token-card--metric[data-tone="warning"] .token-card__icon { color: rgb(var(--color-warning)); }
.token-card--metric .token-card__label { margin-top: 12px; }
.token-card--metric strong { margin-top: 10px; font-size: 28px; }
@media (min-width: 640px) {
  .usage-summary { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .token-card--hero { grid-column: 1 / -1; }
  .token-card--request { grid-column: auto; min-height: 140px; }
}
@media (min-width: 1100px) {
  .usage-summary { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .token-card--hero { grid-column: span 2; }
}
</style>
