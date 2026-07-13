<script setup lang="ts">
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap } from "../../types";

const draft = defineModel<ConfigSectionValueMap["broadcastStorm"]>({ required: true });
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
    </fieldset>
  </section>
</template>
