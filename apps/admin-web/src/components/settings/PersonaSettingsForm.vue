<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["persona"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">Agent 身份</h2>
    </div>
    <div class="grid gap-5">
      <label class="field">
        <span class="field-label">Agent ID</span>
        <input class="control" type="text" value="plana" disabled>
      </label>
      <label class="field">
        <span class="field-label">工作目录</span>
        <input v-model.trim="draft.agentWorkspace" class="control" type="text" autocomplete="off">
      </label>
      <label class="field max-w-xs">
        <span class="field-label">记忆上限</span>
        <input v-model.number="draft.memoryLimit" class="control" type="number" min="1" max="10000" step="1">
      </label>
    </div>
  </section>
</template>
