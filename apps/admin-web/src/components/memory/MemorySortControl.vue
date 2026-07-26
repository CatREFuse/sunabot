<script setup lang="ts">
import type { MemorySortDirection, MemorySortField } from "../../utils/memorySort";

defineProps<{
  field: MemorySortField;
  direction: MemorySortDirection;
  fields?: readonly MemorySortField[];
}>();
const emit = defineEmits<{
  "update:field": [field: MemorySortField];
  "update:direction": [direction: MemorySortDirection];
}>();

const labels: Readonly<Record<MemorySortField, string>> = {
  createdAt: "添加时间",
  updatedAt: "更新时间",
  lastRecalledAt: "召回时间"
};
const defaultFields: readonly MemorySortField[] = ["createdAt", "updatedAt", "lastRecalledAt"];
</script>

<template>
  <div class="flex min-w-0 items-center gap-1 border-l border-line pl-2" aria-label="记忆排序">
    <select
      class="min-h-11 min-w-0 appearance-none bg-transparent px-3 font-mono text-[11px] text-ink outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-display"
      :value="field"
      aria-label="排序字段"
      @change="emit('update:field', ($event.target as HTMLSelectElement).value as MemorySortField)"
    >
      <option v-for="option in fields ?? defaultFields" :key="option" :value="option">{{ labels[option] }}</option>
    </select>
    <button
      class="icon-btn"
      type="button"
      :aria-label="direction === 'desc' ? '当前新到旧，切换为旧到新' : '当前旧到新，切换为新到旧'"
      @click="emit('update:direction', direction === 'desc' ? 'asc' : 'desc')"
    >
      <i class="bx" :class="direction === 'desc' ? 'bx-sort-down' : 'bx-sort-up'" aria-hidden="true"></i>
    </button>
  </div>
</template>
