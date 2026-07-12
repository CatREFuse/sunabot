<script setup lang="ts">
import type { ConfigSectionKey } from "../../types";

defineProps<{
  current: ConfigSectionKey;
  sections: Array<{ id: ConfigSectionKey; label: string; group: string; icon: string }>;
  dirty: (key: ConfigSectionKey) => boolean;
}>();
const emit = defineEmits<{ select: [key: ConfigSectionKey] }>();
</script>

<template>
  <aside class="hidden min-w-0 lg:block">
    <nav class="sticky top-8 grid" aria-label="设置分区">
      <template v-for="(section, index) in sections" :key="section.id">
        <p v-if="index === 0 || sections[index - 1]?.group !== section.group" class="px-3 pb-2 pt-5 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled">{{ section.group }}</p>
        <button
          class="group flex min-h-12 items-center gap-3 border-b border-line px-3 text-left transition-colors duration-200 hover:bg-raised"
          :class="current === section.id ? 'bg-raised text-display' : 'text-mute'"
          type="button"
          @click="emit('select', section.id)"
        >
          <i class="bx text-lg" :class="section.icon" aria-hidden="true"></i>
          <span class="text-sm">{{ section.label }}</span>
          <span v-if="dirty(section.id)" class="ml-auto font-mono text-[10px] text-warning"><i class="bx bx-edit" aria-hidden="true"></i></span>
        </button>
      </template>
    </nav>
  </aside>

  <label class="field lg:hidden">
    <span class="field-label">设置分区</span>
    <select :value="current" class="control" @change="emit('select', ($event.target as HTMLSelectElement).value as ConfigSectionKey)">
      <optgroup v-for="group in [...new Set(sections.map((section) => section.group))]" :key="group" :label="group">
        <option v-for="section in sections.filter((item) => item.group === group)" :key="section.id" :value="section.id">{{ section.label }}{{ dirty(section.id) ? " · 未保存" : "" }}</option>
      </optgroup>
    </select>
  </label>
</template>
