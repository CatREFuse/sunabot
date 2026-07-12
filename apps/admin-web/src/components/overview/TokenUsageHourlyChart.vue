<script setup lang="ts">
import { computed } from "vue";
import type { TokenUsagePayload } from "../../types";
import { formatExactNumber, formatPercent } from "../../utils/numberFormat";

const PLOT_BOTTOM = 210;
const PLOT_HEIGHT = 176;
const HOUR_STEP = 29;

const props = defineProps<{ hours: TokenUsagePayload["hours"] }>();
const maxTotal = computed(() => Math.max(1, ...props.hours.map((hour) => hour.total)));
const ratePoints = computed(() => props.hours.flatMap((hour, index) => {
  if (hour.cacheRate == null) return [];
  const rate = clampRate(hour.cacheRate);
  return [{ key: `${hour.hour}-${index}`, hour: hour.hour, rate, x: hourX(index), y: rateY(rate) }];
}));
const lineSegments = computed(() => {
  const segments: string[] = [];
  let current: string[] = [];
  for (let index = 0; index < props.hours.length; index += 1) {
    const hour = props.hours[index]!;
    if (hour.cacheRate == null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${hourX(index)},${rateY(clampRate(hour.cacheRate))}`);
  }
  if (current.length > 1) segments.push(current.join(" "));
  return segments;
});

function clampRate(rate: number) {
  return Math.min(Math.max(rate, 0), 1);
}

function hourX(index: number) {
  return 18 + index * HOUR_STEP;
}

function rateY(rate: number) {
  return PLOT_BOTTOM - rate * PLOT_HEIGHT;
}

function barHeight(total: number) {
  return total / maxTotal.value * PLOT_HEIGHT;
}
</script>

<template>
  <article class="usage-chart">
    <header class="usage-chart__header">
      <span class="usage-card__label"><i class="bx bx-bar-chart-alt-2" aria-hidden="true"></i>今日小时分布</span>
      <span class="chart-legend" aria-label="图例">
        <span><i class="bx bx-bar-chart-alt-2 chart-legend__bar" aria-hidden="true"></i>总 Token</span>
        <span><i class="bx bx-trending-up chart-legend__line" aria-hidden="true"></i>缓存率</span>
      </span>
    </header>
    <svg class="hour-chart" viewBox="0 0 720 240" role="img" aria-label="今日每小时 Token 总量与输入缓存率">
      <title>今日每小时 Token 与缓存率</title>
      <line x1="0" :y1="PLOT_BOTTOM" x2="720" :y2="PLOT_BOTTOM" class="chart-axis" />
      <rect
        v-for="(hour, index) in hours"
        :key="hour.hour"
        :x="8 + index * HOUR_STEP"
        :y="PLOT_BOTTOM - barHeight(hour.total)"
        width="19"
        :height="barHeight(hour.total)"
        class="chart-bar"
      ><title>{{ hour.hour }}:00 · {{ formatExactNumber(hour.total) }} Token · 缓存率 {{ formatPercent(hour.cacheRate) }}</title></rect>
      <polyline v-for="(points, index) in lineSegments" :key="index" :points="points" class="chart-line" />
      <circle v-for="point in ratePoints" :key="point.key" :cx="point.x" :cy="point.y" r="2.5" class="chart-point">
        <title>{{ point.hour }}:00 · 缓存率 {{ formatPercent(point.rate) }}</title>
      </circle>
      <text x="710" y="31" text-anchor="end" class="chart-rate-label">100%</text>
      <text x="710" y="207" text-anchor="end" class="chart-rate-label">0%</text>
      <text v-for="hour in [0, 6, 12, 18, 23]" :key="hour" :x="8 + hour * HOUR_STEP" y="232" class="chart-label">{{ hour }}</text>
    </svg>
  </article>
</template>

<style scoped>
.usage-chart { min-width: 0; overflow: hidden; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); padding: 16px; }
.usage-chart__header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 16px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.usage-card__label, .chart-legend, .chart-legend span { display: flex; align-items: center; }
.usage-card__label { gap: 7px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.chart-legend { flex-wrap: wrap; gap: 12px; }
.chart-legend span { gap: 4px; }
.chart-legend__bar { color: rgb(var(--color-interactive)); }
.chart-legend__line { color: rgb(var(--color-success)); }
.hour-chart { display: block; width: 100%; min-height: 190px; margin-top: 8px; overflow: visible; }
.chart-axis { stroke: rgb(var(--color-visible)); stroke-width: 1; }
.chart-bar { fill: color-mix(in srgb, rgb(var(--color-interactive)) 40%, transparent); }
.chart-line { fill: none; stroke: rgb(var(--color-success)); stroke-width: 2; vector-effect: non-scaling-stroke; }
.chart-point { fill: rgb(var(--color-panel)); stroke: rgb(var(--color-success)); stroke-width: 2; vector-effect: non-scaling-stroke; }
.chart-label, .chart-rate-label { fill: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.chart-rate-label { fill: rgb(var(--color-success)); font-size: 9px; }
</style>
