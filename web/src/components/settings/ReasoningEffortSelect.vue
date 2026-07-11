<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { ModelCatalogItem, ReasoningEffort } from "../../types";

const effort = defineModel<ReasoningEffort | undefined>({ required: true });
const props = defineProps<{ model: string; models: readonly ModelCatalogItem[]; label?: string }>();
const all: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const entry = computed(() => props.models.find((item) => item.id === props.model));
const options = computed(() => entry.value?.supportedReasoningEfforts ?? all);
const adjusted = shallowRef("");

watch(
  [() => props.model, options],
  () => {
    const current = effort.value;
    if (!current || !options.value.includes(current)) {
      const next = entry.value?.defaultReasoningEffort ?? current ?? "medium";
      effort.value = next;
      adjusted.value = `[ADJUSTED TO ${next.toUpperCase()}]`;
    } else {
      adjusted.value = "";
    }
  },
  { immediate: true }
);
</script>

<template>
  <label class="field">
    <span class="field-label">{{ label || "推理强度" }}</span>
    <select v-model="effort" class="control" @change="adjusted = ''">
      <option v-for="item in options" :key="item" :value="item">{{ item }}</option>
    </select>
    <small v-if="adjusted" class="font-mono text-[10px] text-warning">{{ adjusted }}</small>
  </label>
</template>
