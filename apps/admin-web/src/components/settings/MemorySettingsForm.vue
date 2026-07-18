<script setup lang="ts">
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";
import type { ConfigSectionValueMap, ModelCatalogItem } from "../../types";

const draft = defineModel<ConfigSectionValueMap["memory"]>({ required: true });
defineProps<{ models: readonly ModelCatalogItem[] }>();
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">记忆处理</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <ModelSelect v-model="draft.memoryModel" :models="models" />
      <ReasoningEffortSelect v-model="draft.reasoningEffort" :model="draft.memoryModel" :models="models" />
      <label class="field">
        <span class="field-label">压缩阈值</span>
        <SettingsConfirmInput v-model.number="draft.messageThreshold" type="number" min="1" max="200" step="1" confirm-label="确认压缩阈值" />
      </label>
      <label class="field">
        <span class="field-label">工作记忆上限</span>
        <SettingsConfirmInput v-model.number="draft.workingMemoryMaxEntries" type="number" min="1" max="1000" step="1" confirm-label="确认工作记忆上限" />
      </label>
    </div>
    <div class="border-t border-line pt-6">
      <h3 class="text-base font-medium text-display">提示词文件</h3>
      <div class="mt-4 grid gap-5 lg:grid-cols-3">
        <label class="field">
          <span class="field-label">写入压缩</span>
          <SettingsConfirmInput v-model.trim="draft.workMemoryCompressInPrompt" type="text" confirm-label="确认写入压缩文件" />
          <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/memory.compress-in">编辑正文 →</RouterLink>
        </label>
        <label class="field">
          <span class="field-label">归档压缩</span>
          <SettingsConfirmInput v-model.trim="draft.workMemoryCompressOutPrompt" type="text" confirm-label="确认归档压缩文件" />
          <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/memory.compress-out">编辑正文 →</RouterLink>
        </label>
        <label class="field">
          <span class="field-label">用户画像</span>
          <SettingsConfirmInput v-model.trim="draft.userProfilePrompt" type="text" confirm-label="确认用户画像文件" />
          <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/memory.user-profile">编辑正文 →</RouterLink>
        </label>
      </div>
    </div>
  </section>
</template>
