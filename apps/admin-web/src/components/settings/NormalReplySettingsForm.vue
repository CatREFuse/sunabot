<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";

const draft = defineModel<ConfigSectionValueMap["normalReply"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">回复重试</h2>
      <p class="mt-2 text-sm leading-6 text-mute">设置全部 Agent 共用的回复失败重试次数。</p>
    </div>

    <div class="settings-group">
      <label class="field max-w-sm">
        <span class="field-label">失败重试次数</span>
        <SettingsConfirmInput
          v-model.number="draft.maxRetries"
          type="number"
          min="0"
          max="10"
          step="1"
          confirm-label="确认失败重试次数"
        />
        <span class="text-xs leading-5 text-mute">0 表示关闭重试，最多 10 次</span>
      </label>
    </div>
  </section>
</template>
