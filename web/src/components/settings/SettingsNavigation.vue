<script setup lang="ts">
import type { ConfigSectionKey } from "../../types";

defineProps<{
  current: ConfigSectionKey;
  sections: Array<{ id: ConfigSectionKey; label: string; meta: string }>;
  dirty: (key: ConfigSectionKey) => boolean;
}>();
const emit = defineEmits<{ select: [key: ConfigSectionKey] }>();
</script>

<template>
  <aside class="hidden min-w-0 lg:block">
    <nav class="sticky top-8 grid" aria-label="设置分区">
      <button
        v-for="section in sections"
        :key="section.id"
        class="group flex min-h-14 items-center gap-3 border-b border-line px-3 text-left transition-colors duration-200 hover:bg-raised"
        :class="current === section.id ? 'bg-raised text-display' : 'text-mute'"
        type="button"
        @click="emit('select', section.id)"
      >
        <span class="font-mono text-[10px] text-disabled">{{ section.meta }}</span>
        <span class="text-sm">{{ section.label }}</span>
        <span v-if="dirty(section.id)" class="ml-auto font-mono text-[10px] text-accent">EDITED</span>
      </button>
    </nav>
  </aside>

  <label class="field lg:hidden">
    <span class="field-label">设置分区</span>
    <select :value="current" class="control" @change="emit('select', ($event.target as HTMLSelectElement).value as ConfigSectionKey)">
      <option v-for="section in sections" :key="section.id" :value="section.id">{{ section.label }}{{ dirty(section.id) ? " · 未保存" : "" }}</option>
    </select>
  </label>
</template>
