<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";

const draft = defineModel<ConfigSectionValueMap["normalReply"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <h2 class="section-title">正常回复</h2>

    <label class="field max-w-sm">
      <span class="field-label">失败重试次数</span>
      <input
        v-model.number="draft.maxRetries"
        class="control"
        type="number"
        min="0"
        max="10"
        step="1"
      >
      <span class="text-xs leading-5 text-mute">0 表示关闭重试，最多 10 次</span>
    </label>
  </section>
</template>
