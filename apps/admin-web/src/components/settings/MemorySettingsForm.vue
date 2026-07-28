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
      <p class="mt-2 text-sm leading-6 text-mute">设置记忆压缩与 Dream 抽样。</p>
    </div>
    <div class="settings-group grid gap-5 sm:grid-cols-2">
      <h3 class="settings-group-title sm:col-span-2">模型与容量</h3>
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
    <div class="settings-group grid gap-5 sm:grid-cols-3">
      <div class="sm:col-span-3">
        <h3 class="settings-group-title">Dream 抽样</h3>
        <p class="mt-2 text-sm leading-6 text-mute">近期与更早记忆合计最多 24 条。</p>
      </div>
      <label class="field">
        <span class="field-label">近期窗口（小时）</span>
        <SettingsConfirmInput v-model.number="draft.dreamRecentWindowHours" data-config-field="memory.dreamRecentWindowHours" type="number" min="1" max="720" step="1" confirm-label="确认近期窗口" />
      </label>
      <label class="field">
        <span class="field-label">近期记忆数</span>
        <SettingsConfirmInput v-model.number="draft.dreamRecentMemoryLimit" data-config-field="memory.dreamRecentMemoryLimit" type="number" min="0" max="24" step="1" confirm-label="确认近期记忆数" />
      </label>
      <label class="field">
        <span class="field-label">更早记忆数</span>
        <SettingsConfirmInput v-model.number="draft.dreamOlderMemoryLimit" data-config-field="memory.dreamOlderMemoryLimit" type="number" min="0" max="24" step="1" confirm-label="确认更早记忆数" />
      </label>
    </div>
    <div class="settings-group">
      <h3 class="settings-group-title">提示词文件</h3>
      <div class="mt-4 grid gap-5 lg:grid-cols-4">
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
        <div class="field">
          <span class="field-label">Dream</span>
          <span class="control flex items-center font-mono text-xs">memory_dream.json</span>
          <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/memory.dream">编辑正文 →</RouterLink>
        </div>
      </div>
    </div>
  </section>
</template>
