<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { TokenUsageBehavior, TokenUsageFilters, TokenUsagePayload } from "../../types";
import TokenUsageCalendar from "./TokenUsageCalendar.vue";
import TokenUsageHourlyChart from "./TokenUsageHourlyChart.vue";
import TokenUsageSummaryCards from "./TokenUsageSummaryCards.vue";

const UNLABELED_MODEL = "__unlabeled__";
const props = defineProps<{
  usage: TokenUsagePayload | null;
  loading: boolean;
  model?: string;
  behavior?: TokenUsageBehavior;
}>();
const emit = defineEmits<{ filtersChange: [filters: TokenUsageFilters] }>();
const granularity = shallowRef<"hour" | "day">("hour");
const models = computed(() => props.usage?.filters?.models ?? []);
const behaviorOptions: Array<{ value: TokenUsageBehavior; label: string }> = [
  { value: "", label: "全部功能" },
  { value: "reply", label: "回答" },
  { value: "orchestrator", label: "编排器" },
  { value: "memory", label: "记忆" },
  { value: "other", label: "其他" }
];

function modelLabel(model: string) {
  return model === UNLABELED_MODEL ? "未标注模型" : model;
}

function updateModel(event: Event) {
  emit("filtersChange", {
    model: (event.target as HTMLSelectElement).value,
    behavior: props.behavior ?? ""
  });
}

function updateBehavior(event: Event) {
  emit("filtersChange", {
    model: props.model ?? "",
    behavior: (event.target as HTMLSelectElement).value as TokenUsageBehavior
  });
}
</script>

<template>
  <section class="token-section" aria-label="Token 消耗统计">
    <header class="token-section__header">
      <h2 class="section-title">Token 消耗</h2>
      <span class="font-mono text-[10px] text-mute"><i class="bx bx-calendar mr-1" aria-hidden="true"></i>{{ usage?.today.date ?? "--" }}</span>
    </header>
    <div class="token-controls" aria-label="Token 筛选">
      <div class="granularity-switch" role="group" aria-label="时间粒度">
        <button type="button" :aria-pressed="granularity === 'hour'" @click="granularity = 'hour'">小时</button>
        <button type="button" :aria-pressed="granularity === 'day'" @click="granularity = 'day'">日</button>
      </div>
      <label class="token-filter">
        <span>模型</span>
        <select :value="model ?? ''" aria-label="筛选 Token 模型" :disabled="loading" @change="updateModel">
          <option value="">全部模型</option>
          <option v-for="item in models" :key="item" :value="item">{{ modelLabel(item) }}</option>
        </select>
      </label>
      <label class="token-filter">
        <span>功能</span>
        <select :value="behavior ?? ''" aria-label="筛选 Token 功能" :disabled="loading" @change="updateBehavior">
          <option v-for="item in behaviorOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
    </div>
    <div class="token-mosaic">
      <TokenUsageSummaryCards class="token-mosaic__summary" :usage="usage?.today ?? null" />
      <TokenUsageHourlyChart v-if="granularity === 'hour'" class="token-mosaic__chart" :hours="usage?.hours ?? []" />
      <TokenUsageCalendar v-else class="token-mosaic__chart" :days="usage?.days ?? []" />
    </div>
    <p v-if="loading" class="mt-4 font-mono text-[10px] text-mute">加载中</p>
  </section>
</template>

<style scoped>
.token-section { margin-top: 48px; }
.token-section__header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.token-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px 20px; border-block: 1px solid rgb(var(--color-line)); padding: 12px 0; }
.granularity-switch { display: grid; grid-template-columns: repeat(2, minmax(64px, 1fr)); border: 1px solid rgb(var(--color-visible)); }
.granularity-switch button { min-height: 44px; border: 0; border-right: 1px solid rgb(var(--color-visible)); background: transparent; padding: 0 16px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.granularity-switch button:last-child { border-right: 0; }
.granularity-switch button[aria-pressed="true"] { background: rgb(var(--color-display)); color: rgb(var(--color-page)); }
.token-filter { display: grid; min-width: min(100%, 180px); gap: 5px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.token-filter select { min-height: 44px; border: 0; border-bottom: 1px solid rgb(var(--color-visible)); background: transparent; padding: 0 28px 0 0; color: rgb(var(--color-display)); font-family: "Space Mono", monospace; font-size: 11px; }
.token-mosaic { display: grid; gap: 32px; }
.token-mosaic__summary { min-width: 0; }
@media (min-width: 1100px) {
  .token-controls { justify-content: flex-end; }
  .granularity-switch { margin-right: auto; }
}
</style>
