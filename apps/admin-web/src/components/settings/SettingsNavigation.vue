<script setup lang="ts">
import type { SettingsSectionKey } from "../../types";
import type { SettingsSectionDefinition } from "./settingsCatalog";

defineProps<{
  current: SettingsSectionKey;
  sections: SettingsSectionDefinition[];
}>();
const emit = defineEmits<{ select: [key: SettingsSectionKey] }>();
</script>

<template>
  <aside class="hidden min-w-0 lg:block">
    <nav class="sticky top-8 grid" aria-label="设置分区">
      <template v-for="(section, index) in sections" :key="section.id">
        <p v-if="index === 0 || sections[index - 1]?.group !== section.group" class="pb-2 pt-6 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled first:pt-0">{{ section.group }}</p>
        <button
          class="group grid min-h-14 grid-cols-[24px_minmax(0,1fr)] items-start gap-2 border-b border-l-2 border-b-line py-3 pl-3 pr-1 text-left transition-colors duration-200 hover:text-display"
          :class="current === section.id ? 'border-l-display text-display' : 'border-l-transparent text-mute'"
          type="button"
          @click="emit('select', section.id)"
        >
          <span class="font-mono text-[10px] text-disabled">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="min-w-0">
            <strong class="block text-sm font-normal">{{ section.label }}</strong>
            <small v-if="current === section.id" class="mt-1 block text-[11px] leading-4 text-mute">{{ section.description }}</small>
          </span>
        </button>
      </template>
    </nav>
  </aside>

  <div class="border-y border-line py-4 lg:hidden">
    <label class="field">
      <span class="flex items-center justify-between gap-4">
        <span class="field-label">设置分区</span>
        <span class="font-mono text-[10px] text-disabled">{{ sections.findIndex((section) => section.id === current) + 1 }} / {{ sections.length }}</span>
      </span>
      <select :value="current" class="control" @change="emit('select', ($event.target as HTMLSelectElement).value as SettingsSectionKey)">
        <optgroup v-for="group in [...new Set(sections.map((section) => section.group))]" :key="group" :label="group">
          <option v-for="section in sections.filter((item) => item.group === group)" :key="section.id" :value="section.id">{{ section.label }}</option>
        </optgroup>
      </select>
    </label>
    <p class="mt-2 text-xs leading-5 text-mute">{{ sections.find((section) => section.id === current)?.description }}</p>
  </div>
</template>
