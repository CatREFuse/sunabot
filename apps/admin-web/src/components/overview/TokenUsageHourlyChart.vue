<script setup lang="ts">
import { computed } from "vue";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { use, type EChartsCoreOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { TokenUsagePayload } from "../../types";
import { formatExactNumber, formatPercent } from "../../utils/numberFormat";
import { useTheme } from "../../composables/useTheme";
import EChart from "../ui/EChart.vue";

use([BarChart, LineChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

const props = defineProps<{ hours: TokenUsagePayload["hours"] }>();
const { effectiveTheme } = useTheme();

function clampRate(rate: number) {
  return Math.min(Math.max(rate, 0), 1);
}

const option = computed<EChartsCoreOption>(() => {
  const dark = effectiveTheme.value === "dark";
  const colors = {
    text: dark ? "#999999" : "#666666",
    line: dark ? "#333333" : "#cccccc",
    bar: dark ? "#b8b8b8" : "#7d7d7d",
    success: dark ? "#4a9e5c" : "#39844a",
    page: dark ? "#000000" : "#f5f5f5",
    tooltip: dark ? "#111111" : "#ffffff",
    display: dark ? "#ffffff" : "#000000"
  };

  return {
    animation: false,
    aria: { enabled: true, description: "今日每小时 Token 总量与输入缓存率" },
    grid: { top: 42, right: 44, bottom: 30, left: 8, outerBoundsMode: "same" },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 12,
      itemHeight: 7,
      textStyle: { color: colors.text, fontFamily: "Space Mono", fontSize: 10 },
      data: ["总 Token", "缓存率"]
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: colors.tooltip,
      borderColor: colors.line,
      borderWidth: 1,
      textStyle: { color: colors.display, fontFamily: "Space Mono", fontSize: 11 },
      axisPointer: { type: "shadow", shadowStyle: { color: dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.035)" } },
      formatter: (params: Array<{ seriesName: string; value: number | null; axisValue: string }>) => {
        const hour = params[0]?.axisValue ?? "";
        const rows = params.flatMap((item) => item.value == null ? [] : [
          `${item.seriesName}　${item.seriesName === "缓存率" ? formatPercent(item.value) : `${formatExactNumber(item.value)} Token`}`
        ]);
        return [`${hour}:00`, ...rows].join("<br>");
      }
    },
    xAxis: {
      type: "category",
      data: props.hours.map((hour) => String(hour.hour)),
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.text,
        fontFamily: "Space Mono",
        fontSize: 10,
        interval: 0,
        formatter: (value: string) => ["0", "6", "12", "18", "23"].includes(value) ? value : ""
      }
    },
    yAxis: [
      {
        type: "value",
        min: 0,
        splitNumber: 3,
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colors.line, opacity: 0.38, type: "dashed" } }
      },
      {
        type: "value",
        min: 0,
        max: 1,
        interval: 1,
        axisLabel: {
          color: colors.success,
          fontFamily: "Space Mono",
          fontSize: 10,
          formatter: (value: number) => formatPercent(value)
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "总 Token",
        type: "bar",
        data: props.hours.map((hour) => hour.total),
        barMaxWidth: 22,
        itemStyle: { color: colors.bar, opacity: dark ? 0.72 : 0.62 }
      },
      {
        name: "缓存率",
        type: "line",
        yAxisIndex: 1,
        data: props.hours.map((hour) => hour.cacheRate == null ? null : clampRate(hour.cacheRate)),
        connectNulls: false,
        symbol: "circle",
        symbolSize: 7,
        lineStyle: { color: colors.success, width: 2.5 },
        itemStyle: { color: colors.page, borderColor: colors.success, borderWidth: 2.5 },
        emphasis: { scale: 1.25 }
      }
    ]
  };
});
</script>

<template>
  <article class="usage-chart">
    <header class="usage-chart__header">
      <span class="usage-card__label"><i class="bx bx-bar-chart-alt-2" aria-hidden="true"></i>今日小时分布</span>
    </header>
    <EChart class="hour-chart" :option="option" accessible-label="今日每小时 Token 总量与输入缓存率" />
  </article>
</template>

<style scoped>
.usage-chart { min-width: 0; overflow: hidden; border-block: 1px solid rgb(var(--color-line)); background: transparent; padding: 20px 0; }
.usage-chart__header { display: flex; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.usage-card__label { display: flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.hour-chart { width: 100%; height: 240px; margin-top: 8px; }
</style>
