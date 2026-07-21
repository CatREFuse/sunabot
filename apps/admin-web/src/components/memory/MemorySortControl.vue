<script setup lang="ts">
import type { MemorySortDirection, MemorySortField } from "../../utils/memorySort";

defineProps<{
  field: MemorySortField;
  direction: MemorySortDirection;
}>();
const emit = defineEmits<{
  "update:field": [field: MemorySortField];
  "update:direction": [direction: MemorySortDirection];
}>();
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center" aria-label="记忆排序">
    <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">排序</span>
    <select
      class="control sm:w-36"
      :value="field"
      aria-label="排序字段"
      @change="emit('update:field', ($event.target as HTMLSelectElement).value as MemorySortField)"
    >
      <option value="createdAt">添加时间</option>
      <option value="updatedAt">更新时间</option>
      <option value="lastRecalledAt">召回时间</option>
    </select>
    <select
      class="control sm:w-44"
      :value="direction"
      aria-label="排序方向"
      @change="emit('update:direction', ($event.target as HTMLSelectElement).value as MemorySortDirection)"
    >
      <option value="desc">逆序（新到旧）</option>
      <option value="asc">正序（旧到新）</option>
    </select>
  </div>
</template>
