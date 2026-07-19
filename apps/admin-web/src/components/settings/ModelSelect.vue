<script setup lang="ts">
import { computed } from "vue";
import type { ModelCatalogItem } from "../../types";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";

const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{
  models: readonly ModelCatalogItem[];
  label?: string;
  disabled?: boolean;
}>(), {
  label: "",
  disabled: false
});
const knownIds = computed(() => new Set(props.models.map((item) => item.id)));
const selection = computed({
  get: () => (knownIds.value.has(model.value) ? model.value : "__custom__"),
  set: (value: string) => {
    if (value === "__custom__") {
      if (knownIds.value.has(model.value)) model.value = "";
      return;
    }
    model.value = value;
  }
});
const custom = computed(() => selection.value === "__custom__");
</script>

<template>
  <div class="field">
    <label class="field">
      <span class="field-label">{{ label || "模型" }}</span>
      <select v-model="selection" class="control" :disabled="props.disabled">
        <option v-for="item in models" :key="item.id" :value="item.id">{{ item.label }}</option>
        <option value="__custom__">自定义</option>
      </select>
    </label>
    <label v-if="custom" class="field">
      <span class="sr-only">自定义模型 ID</span>
      <SettingsConfirmInput v-model.trim="model" :disabled="props.disabled" type="text" autocomplete="off" placeholder="输入模型 ID" aria-label="自定义模型 ID" confirm-label="确认自定义模型 ID" />
    </label>
  </div>
</template>
