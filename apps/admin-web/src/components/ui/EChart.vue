<script setup lang="ts">
import { init, type EChartsCoreOption } from "echarts/core";
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue";

const props = defineProps<{
  option: EChartsCoreOption;
  accessibleLabel: string;
}>();

const chartRoot = useTemplateRef<HTMLElement>("chartRoot");
const chart = shallowRef<ReturnType<typeof init> | null>(null);
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (!chartRoot.value) return;
  chart.value = init(chartRoot.value, undefined, { renderer: "svg" });
  chart.value.setOption(props.option);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => chart.value?.resize());
    resizeObserver.observe(chartRoot.value);
  }
});

watch(() => props.option, (option) => {
  chart.value?.setOption(option, { notMerge: true });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  chart.value?.dispose();
  chart.value = null;
});
</script>

<template>
  <div ref="chartRoot" class="echart" role="img" :aria-label="accessibleLabel"></div>
</template>

<style scoped>
.echart { width: 100%; height: 100%; }
</style>
