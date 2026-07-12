<script setup lang="ts">
import type { TokenUsagePayload } from "../../types";
import TokenUsageCalendar from "./TokenUsageCalendar.vue";
import TokenUsageHourlyChart from "./TokenUsageHourlyChart.vue";
import TokenUsageSummaryCards from "./TokenUsageSummaryCards.vue";

defineProps<{ usage: TokenUsagePayload | null; loading: boolean }>();
</script>

<template>
  <section class="token-section" aria-label="Token 消耗统计">
    <header class="token-section__header">
      <h2 class="section-title">Token 消耗</h2>
      <span class="font-mono text-[10px] text-mute"><i class="bx bx-calendar mr-1" aria-hidden="true"></i>{{ usage?.today.date ?? "--" }}</span>
    </header>
    <div class="token-mosaic">
      <TokenUsageSummaryCards class="token-mosaic__summary" :usage="usage?.today ?? null" />
      <TokenUsageCalendar class="token-mosaic__calendar" :days="usage?.days ?? []" />
      <TokenUsageHourlyChart class="token-mosaic__chart" :hours="usage?.hours ?? []" />
    </div>
    <p v-if="loading" class="mt-4 font-mono text-[10px] text-mute">加载中</p>
  </section>
</template>

<style scoped>
.token-section { margin-top: 48px; }
.token-section__header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.token-mosaic { display: grid; gap: 32px; }
.token-mosaic__summary { min-width: 0; }
@media (min-width: 1100px) {
  .token-mosaic { grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 32px 24px; }
  .token-mosaic__summary { grid-column: 1 / -1; }
  .token-mosaic__calendar { grid-column: span 3; }
  .token-mosaic__chart { grid-column: span 4; }
}
</style>
