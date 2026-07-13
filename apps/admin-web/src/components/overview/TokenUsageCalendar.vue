<script setup lang="ts">
import { computed, nextTick, onMounted, useTemplateRef, watch } from "vue";
import { HeatmapChart } from "echarts/charts";
import { AriaComponent, CalendarComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { use, type EChartsCoreOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { TokenUsagePayload } from "../../types";
import { formatExactNumber } from "../../utils/numberFormat";
import { useTheme } from "../../composables/useTheme";
import EChart from "../ui/EChart.vue";

use([HeatmapChart, AriaComponent, CalendarComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

const props = defineProps<{ days: TokenUsagePayload["days"] }>();
const { effectiveTheme } = useTheme();
const calendarWrap = useTemplateRef<HTMLElement>("calendarWrap");
const dayMap = computed(() => new Map(props.days.map((day) => [day.date, day.total])));
const maxDay = computed(() => Math.max(1, ...dayMap.value.values()));
const calendar = computed(() => {
  const values: Array<[string, number]> = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const total = dayMap.value.get(key) ?? 0;
    values.push([key, total]);
  }
  return values;
});
const option = computed<EChartsCoreOption>(() => {
  const dark = effectiveTheme.value === "dark";
  const text = dark ? "#999999" : "#666666";
  const line = dark ? "#333333" : "#dedede";
  const display = dark ? "#ffffff" : "#000000";

  return {
    animation: false,
    aria: { enabled: true, description: "最近 53 周每日 Token 消耗日历" },
    tooltip: {
      backgroundColor: dark ? "#111111" : "#ffffff",
      borderColor: line,
      borderWidth: 1,
      textStyle: { color: display, fontFamily: "Space Mono", fontSize: 11 },
      formatter: (item: { value: [string, number] }) => `${item.value[0]}<br>${formatExactNumber(item.value[1])} Token`
    },
    visualMap: {
      show: false,
      min: 0,
      max: maxDay.value,
      inRange: { color: dark ? ["#1a1a1a", "#234a2c", "#367443", "#4a9e5c"] : ["#f0f0f0", "#bcd7c2", "#78ae84", "#39844a"] }
    },
    calendar: {
      top: 28,
      left: 28,
      right: 8,
      bottom: 4,
      range: [calendar.value[0]?.[0], calendar.value.at(-1)?.[0]],
      cellSize: [12, 12],
      orient: "horizontal",
      splitLine: { show: false },
      itemStyle: { borderWidth: 2, borderColor: dark ? "#000000" : "#f5f5f5" },
      dayLabel: { firstDay: 1, nameMap: ["日", "一", "二", "三", "四", "五", "六"], color: text, fontFamily: "Space Mono", fontSize: 9 },
      monthLabel: { color: text, fontFamily: "Space Mono", fontSize: 9, nameMap: "ZH" },
      yearLabel: { show: false }
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data: calendar.value }]
  };
});

async function showLatestDays() {
  await nextTick();
  if (calendarWrap.value) calendarWrap.value.scrollLeft = calendarWrap.value.scrollWidth;
}

onMounted(showLatestDays);
watch(() => props.days, showLatestDays);
</script>

<template>
  <article class="usage-calendar">
    <header><span class="usage-card__label"><i class="bx bx-grid-alt" aria-hidden="true"></i>最近 53 周</span><span>每日总量</span></header>
    <div ref="calendarWrap" class="calendar-wrap">
      <EChart class="calendar" :option="option" accessible-label="每日 Token 消耗日历" />
    </div>
  </article>
</template>

<style scoped>
.usage-calendar { min-width: 0; overflow: hidden; border-block: 1px solid rgb(var(--color-line)); background: transparent; padding: 20px 0; }
.usage-calendar header { display: flex; justify-content: space-between; gap: 12px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.usage-card__label { display: flex; align-items: center; gap: 7px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.calendar-wrap { margin-top: 12px; overflow-x: auto; padding-bottom: 4px; }
.calendar { width: max(100%, 720px); height: 132px; }
</style>
