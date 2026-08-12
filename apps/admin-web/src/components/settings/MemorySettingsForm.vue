<script setup lang="ts">
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import type { ConfigSectionValueMap, ModelCatalogItem } from "../../types";

const draft = defineModel<ConfigSectionValueMap["memory"]>({ required: true });
defineProps<{ models: readonly ModelCatalogItem[] }>();
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">记忆处理</h2>
      <p class="mt-2 text-sm leading-6 text-mute">设置 Dream 记忆整理。</p>
    </div>
    <div class="settings-group grid gap-5 sm:grid-cols-2">
      <h3 class="settings-group-title sm:col-span-2">模型</h3>
      <ModelSelect v-model="draft.memoryModel" :models="models" />
      <ReasoningEffortSelect v-model="draft.reasoningEffort" :model="draft.memoryModel" :models="models" />
    </div>
    <div class="settings-group">
      <h3 class="settings-group-title">提示词文件</h3>
      <div class="mt-4 grid gap-5">
        <div class="field">
          <span class="field-label">Dream</span>
          <span class="control flex items-center font-mono text-xs">memory_dream.json</span>
          <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/memory.dream">编辑正文 →</RouterLink>
        </div>
      </div>
    </div>
  </section>
</template>
