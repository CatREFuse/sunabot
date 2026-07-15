<script setup lang="ts">
import { computed } from "vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap } from "../../types";

const draft = defineModel<ConfigSectionValueMap["broadcastStorm"]>({ required: true });
const additionalQqIds = computed({
  get: () => draft.value.additionalQqIds.join(", "),
  set: (value: string) => {
    draft.value.additionalQqIds = [...new Set(
      value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
    )];
  }
});
</script>

<template>
  <section class="grid gap-8">
    <h2 class="section-title">广播风暴</h2>

    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.enabled" label="广播风暴嗅探" />
    </div>

    <fieldset class="grid gap-5 sm:grid-cols-3" :disabled="!draft.enabled">
      <label class="field">
        <span class="field-label">检测窗口（分钟）</span>
        <input
          v-model.number="draft.windowMinutes"
          class="control"
          type="number"
          min="1"
          max="1440"
          step="1"
        >
      </label>
      <label class="field">
        <span class="field-label">回复次数</span>
        <input
          v-model.number="draft.replyThreshold"
          class="control"
          type="number"
          min="1"
          max="100"
          step="1"
        >
      </label>
      <label class="field">
        <span class="field-label">静默时长（分钟）</span>
        <input
          v-model.number="draft.cooldownMinutes"
          class="control"
          type="number"
          min="1"
          max="1440"
          step="1"
        >
      </label>
      <label class="field sm:col-span-3">
        <span class="field-label">补充嗅探账号</span>
        <input
          v-model="additionalQqIds"
          class="control"
          type="text"
          autocomplete="off"
          placeholder="123456789, 987654321"
        >
        <span class="text-xs leading-5 text-mute">用逗号或空格分隔 QQ</span>
      </label>
    </fieldset>
  </section>
</template>
