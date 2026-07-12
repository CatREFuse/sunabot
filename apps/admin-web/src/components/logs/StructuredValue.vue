<script setup lang="ts">
import { computed } from "vue";

defineOptions({ name: "StructuredValue" });
const props = withDefaults(defineProps<{ value: unknown; name?: string; depth?: number }>(), { name: "", depth: 0 });
const objectValue = computed(() => props.value != null && typeof props.value === "object");
const entries = computed(() => objectValue.value ? Object.entries(props.value as Record<string, unknown>) : []);
const primitive = computed(() => {
  if (props.value === null) return "null";
  if (props.value === undefined) return "undefined";
  if (typeof props.value === "string") return props.value;
  return String(props.value);
});
const type = computed(() => Array.isArray(props.value) ? "array" : typeof props.value);
</script>

<template>
  <details v-if="objectValue" class="structured" :open="depth < 1">
    <summary>
      <span v-if="name" class="structured__key">{{ name }}</span>
      <span class="structured__count">{{ Array.isArray(value) ? `${entries.length} 项` : `${entries.length} 个字段` }}</span>
    </summary>
    <div class="structured__children">
      <StructuredValue v-for="([key, child]) in entries" :key="key" :name="key" :value="child" :depth="depth + 1" />
      <span v-if="!entries.length" class="structured__empty">空</span>
    </div>
  </details>
  <div v-else class="structured__primitive">
    <span v-if="name" class="structured__key">{{ name }}</span>
    <span class="structured__value" :data-type="type">{{ primitive }}</span>
  </div>
</template>

<style scoped>
.structured { min-width: 0; border-bottom: 1px solid rgb(var(--color-line)); }
.structured summary,
.structured__primitive { display: grid; grid-template-columns: minmax(112px, .55fr) minmax(0, 1.45fr); gap: 16px; align-items: start; min-height: 36px; padding: 8px 0; }
.structured summary { cursor: pointer; list-style-position: inside; }
.structured__key { min-width: 0; overflow-wrap: anywhere; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.structured__count { color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 10px; }
.structured__value { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: rgb(var(--color-ink)); font-size: 12px; }
.structured__value[data-type="number"], .structured__value[data-type="boolean"] { color: rgb(var(--color-interactive)); font-family: "Space Mono", monospace; }
.structured__children { margin-left: 12px; padding-left: 12px; border-left: 1px solid rgb(var(--color-visible)); }
.structured__empty { display: block; padding: 8px 0; color: rgb(var(--color-disabled)); font-family: "Space Mono", monospace; font-size: 10px; }
@media (max-width: 560px) { .structured summary, .structured__primitive { grid-template-columns: 1fr; gap: 3px; } }
</style>
