<script setup lang="ts">
import { computed } from "vue";
import type { TokenUsagePayload } from "../../types";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";

const props = defineProps<{ usage: TokenUsagePayload | null; loading: boolean }>();
const dayMap = computed(() => new Map((props.usage?.days ?? []).map((day) => [day.date, day.total])));
const maxDay = computed(() => Math.max(1, ...dayMap.value.values()));
const calendar = computed(() => {
  const values: Array<{ date: string; total: number; level: number }> = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const total = dayMap.value.get(key) ?? 0;
    values.push({ date: key, total, level: total ? Math.max(1, Math.ceil(total / maxDay.value * 4)) : 0 });
  }
  return values;
});
const maxHour = computed(() => Math.max(1, ...(props.usage?.hours ?? []).map((hour) => hour.total)));
const linePoints = computed(() => (props.usage?.hours ?? []).map((hour, index) => `${18 + index * 29},${210 - hour.total / maxHour.value * 176}`).join(" "));
function barHeight(total: number) { return total / maxHour.value * 176; }
const metrics = computed(() => [
  { label: "输入", icon: "bx-log-in-circle", value: props.usage?.today.input ?? 0, kind: "interactive" },
  { label: "输出", icon: "bx-log-out-circle", value: props.usage?.today.output ?? 0, kind: "success" },
  { label: "请求", icon: "bx-transfer", value: props.usage?.today.requests ?? 0, kind: "warning" }
]);
</script>

<template>
  <section class="token-section" aria-label="Token 消耗统计">
    <header class="token-section__header">
      <div><p class="page-kicker">TOKEN USAGE</p><h2 class="section-title mt-2">Token 消耗</h2></div>
      <span class="font-mono text-[10px] text-mute"><i class="bx bx-calendar mr-1" aria-hidden="true"></i>{{ usage?.today.date ?? "--" }}</span>
    </header>
    <div class="token-mosaic">
      <article class="token-card token-card--hero">
        <span class="token-card__label"><i class="bx bx-bolt-circle" aria-hidden="true"></i>今日总量</span>
        <strong :title="formatExactNumber(usage?.today.total)">{{ formatDashboardMetric(usage?.today.total) }}</strong>
        <span class="token-card__exact">{{ formatExactNumber(usage?.today.total) }} TOKEN</span>
        <i class="bx bx-line-chart token-card__watermark" aria-hidden="true"></i>
      </article>
      <article v-for="metric in metrics" :key="metric.label" class="token-card token-card--metric" :data-kind="metric.kind">
        <span class="token-card__icon"><i class="bx" :class="metric.icon" aria-hidden="true"></i></span>
        <span class="token-card__label">{{ metric.label }}</span>
        <strong :title="formatExactNumber(metric.value)">{{ formatDashboardMetric(metric.value) }}</strong>
        <span class="token-card__exact">{{ formatExactNumber(metric.value) }}</span>
      </article>

      <article class="token-card token-card--calendar">
        <header><span class="token-card__label"><i class="bx bx-grid-alt" aria-hidden="true"></i>最近 53 周</span><span>每日总量</span></header>
        <div class="calendar-wrap">
          <div class="calendar" role="img" aria-label="每日 Token 消耗日历">
            <span v-for="day in calendar" :key="day.date" :data-level="day.level" :title="`${day.date} · ${formatExactNumber(day.total)} tokens`"></span>
          </div>
        </div>
      </article>

      <article class="token-card token-card--chart">
        <header><span class="token-card__label"><i class="bx bx-bar-chart-alt-2" aria-hidden="true"></i>今日小时分布</span><span>柱形 × 折线</span></header>
        <svg class="hour-chart" viewBox="0 0 720 240" role="img" aria-label="今日每小时 Token 消耗">
          <line x1="0" y1="210" x2="720" y2="210" class="chart-axis" />
          <rect v-for="(hour, index) in usage?.hours ?? []" :key="hour.hour" :x="8 + index * 29" :y="210 - barHeight(hour.total)" width="19" :height="barHeight(hour.total)" class="chart-bar"><title>{{ hour.hour }}:00 · {{ formatExactNumber(hour.total) }}</title></rect>
          <polyline v-if="linePoints" :points="linePoints" class="chart-line" />
          <text v-for="hour in [0, 6, 12, 18, 23]" :key="hour" :x="8 + hour * 29" y="232" class="chart-label">{{ hour }}</text>
        </svg>
      </article>
    </div>
    <p v-if="loading" class="mt-4 font-mono text-[10px] text-mute">[LOADING...]</p>
  </section>
</template>

<style scoped>
.token-section { margin-top: 32px; }
.token-section__header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.token-mosaic { display: grid; gap: 12px; }
.token-card { position: relative; min-width: 0; overflow: hidden; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); padding: 16px; }
.token-card__label { display: flex; align-items: center; gap: 7px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.token-card strong { display: block; margin-top: 16px; color: rgb(var(--color-display)); font-family: "Doto", "Space Mono", monospace; font-size: 36px; font-weight: 700; line-height: .92; letter-spacing: -.035em; }
.token-card__exact { display: block; margin-top: 8px; color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 9px; }
.token-card--hero { min-height: 184px; padding: 20px; background: rgb(var(--color-display)); color: rgb(var(--color-page)); }
.token-card--hero .token-card__label, .token-card--hero .token-card__exact { color: rgb(var(--color-page) / .65); }
.token-card--hero strong { margin-top: 24px; color: rgb(var(--color-page)); font-size: clamp(44px, 8vw, 64px); }
.token-card__watermark { position: absolute; right: 16px; bottom: 10px; color: rgb(var(--color-page) / .12); font-size: 88px; }
.token-card--metric { min-height: 140px; }
.token-card__icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; background: rgb(var(--color-raised)); color: rgb(var(--color-interactive)); font-size: 18px; }
.token-card--metric[data-kind="success"] .token-card__icon { color: rgb(var(--color-success)); }
.token-card--metric[data-kind="warning"] .token-card__icon { color: rgb(var(--color-warning)); }
.token-card--metric .token-card__label { margin-top: 12px; }
.token-card--metric strong { margin-top: 10px; font-size: 28px; }
.token-card--calendar header, .token-card--chart header { display: flex; justify-content: space-between; gap: 12px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.calendar-wrap { margin-top: 20px; overflow-x: auto; padding-bottom: 4px; }
.calendar { display: grid; width: max-content; grid-auto-flow: column; grid-template-rows: repeat(7, 10px); gap: 3px; }
.calendar span { width: 10px; height: 10px; border: 1px solid rgb(var(--color-line)); background: rgb(var(--color-raised)); }
.calendar span[data-level="1"] { background: color-mix(in srgb, rgb(var(--color-success)) 30%, rgb(var(--color-page))); }
.calendar span[data-level="2"] { background: color-mix(in srgb, rgb(var(--color-success)) 50%, rgb(var(--color-page))); }
.calendar span[data-level="3"] { background: color-mix(in srgb, rgb(var(--color-success)) 72%, rgb(var(--color-page))); }
.calendar span[data-level="4"] { background: rgb(var(--color-success)); }
.hour-chart { display: block; width: 100%; min-height: 190px; margin-top: 8px; overflow: visible; }
.chart-axis { stroke: rgb(var(--color-visible)); stroke-width: 1; }
.chart-bar { fill: color-mix(in srgb, rgb(var(--color-interactive)) 40%, transparent); }
.chart-line { fill: none; stroke: rgb(var(--color-interactive)); stroke-width: 2; vector-effect: non-scaling-stroke; }
.chart-label { fill: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
@media (min-width: 640px) { .token-mosaic { grid-template-columns: repeat(6, minmax(0, 1fr)); } .token-card--hero { grid-column: span 3; } .token-card--metric { grid-column: span 1; } .token-card--calendar, .token-card--chart { grid-column: span 6; } }
@media (min-width: 1100px) { .token-card--hero { grid-column: span 2; } .token-card--metric { grid-column: span 1; } .token-card--calendar { grid-column: span 3; } .token-card--chart { grid-column: span 3; } }
</style>
