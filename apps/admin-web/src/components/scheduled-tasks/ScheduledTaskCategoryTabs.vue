<script setup lang="ts">
import type { ScheduledTaskCategory } from "../../types/scheduledTasks";

defineProps<{
  active: ScheduledTaskCategory;
  loading: boolean;
}>();
const emit = defineEmits<{ change: [category: ScheduledTaskCategory] }>();

const categories: Array<{ id: ScheduledTaskCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "director", label: "导演任务" },
  { id: "recurring", label: "循环" },
  { id: "scheduled", label: "定时" },
  { id: "archived", label: "归档" }
];
</script>

<template>
  <nav class="task-tabs" role="tablist" aria-label="定时任务分类">
    <button
      v-for="category in categories"
      :id="`scheduled-task-tab-${category.id}`"
      :key="category.id"
      class="task-tab"
      type="button"
      role="tab"
      :aria-selected="active === category.id"
      :aria-controls="`scheduled-task-panel-${category.id}`"
      :disabled="loading"
      @click="emit('change', category.id)"
    >
      {{ category.label }}
    </button>
  </nav>
</template>

<style scoped>
.task-tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid rgb(var(--color-line));
  scrollbar-width: none;
}

.task-tabs::-webkit-scrollbar {
  display: none;
}

.task-tab {
  position: relative;
  min-width: 72px;
  min-height: 44px;
  padding: 0 16px;
  color: rgb(var(--color-mute));
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition: color 160ms ease;
}

.task-tab::after {
  position: absolute;
  right: 12px;
  bottom: -1px;
  left: 12px;
  height: 2px;
  background: transparent;
  content: "";
}

.task-tab:hover:not(:disabled),
.task-tab[aria-selected="true"] {
  color: rgb(var(--color-display));
}

.task-tab[aria-selected="true"]::after {
  background: rgb(var(--color-display));
}

.task-tab:focus-visible {
  outline: 2px solid rgb(var(--color-display));
  outline-offset: -2px;
}

.task-tab:disabled {
  cursor: wait;
  opacity: 0.65;
}
</style>
