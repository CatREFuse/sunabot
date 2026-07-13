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
    </article>
  </section>
</template>

<style scoped>
.usage-summary { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); border-block: 1px solid rgb(var(--color-line)); }
.token-card { position: relative; min-width: 0; overflow: hidden; background: transparent; padding: 18px 0; }
.token-card__label { display: flex; align-items: center; gap: 7px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.token-card strong { display: block; margin-top: 16px; color: rgb(var(--color-display)); font-family: "Doto Variable", "Space Mono", monospace; font-size: 32px; font-weight: 700; line-height: .92; letter-spacing: -.045em; }
.token-card--hero { grid-column: 1 / -1; min-height: 172px; border-bottom: 1px solid rgb(var(--color-line)); padding: 24px 0 28px; }
.token-card--hero strong { margin-top: 26px; font-size: clamp(48px, 8vw, 64px); }
.token-card--metric { min-height: 132px; border-bottom: 1px solid rgb(var(--color-line)); padding: 18px 14px; }
.token-card--metric:nth-child(odd) { border-left: 1px solid rgb(var(--color-line)); }
.token-card--request { grid-column: 1 / -1; min-height: 112px; border-bottom: 0; border-left: 0; padding-inline: 0; }
.token-card__icon { display: grid; width: 28px; height: 28px; place-items: center; background: transparent; color: rgb(var(--color-mute)); font-size: 25px; }
.token-card--metric[data-tone="interactive"] .token-card__icon { color: rgb(var(--color-interactive)); }
.token-card--metric[data-tone="success"] .token-card__icon { color: rgb(var(--color-success)); }
.token-card--metric[data-tone="warning"] .token-card__icon { color: rgb(var(--color-warning)); }
.token-card--metric .token-card__label { margin-top: 14px; }
.token-card--metric strong { margin-top: 10px; font-size: 26px; }
@media (min-width: 640px) {
  .usage-summary { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .token-card--hero { grid-column: 1 / -1; }
  .token-card--metric { min-height: 140px; border-bottom: 0; border-left: 1px solid rgb(var(--color-line)); padding: 20px 16px; }
  .token-card--metric:nth-child(2) { border-left: 0; padding-left: 0; }
  .token-card--request { grid-column: auto; min-height: 140px; border-left: 1px solid rgb(var(--color-line)); padding-left: 16px; }
}
@media (min-width: 1100px) {
  .usage-summary { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .token-card--hero { grid-column: span 2; border-bottom: 0; padding-right: 24px; }
  .token-card--metric:nth-child(2) { border-left: 1px solid rgb(var(--color-line)); padding-left: 18px; }
}
</style>
