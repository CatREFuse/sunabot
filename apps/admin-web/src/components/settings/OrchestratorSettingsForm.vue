<script setup lang="ts">
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap, ModelCatalogItem } from "../../types";

const draft = defineModel<ConfigSectionValueMap["orchestrator"]>({ required: true });
const groupEnabled = defineModel<boolean>("groupEnabled", { required: true });
defineProps<{ models: readonly ModelCatalogItem[] }>();
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">群聊编排器</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <ModelSelect v-model="draft.groupThreadModel" :models="models" label="Thread 拆分模型" />
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="groupEnabled" label="启用" />
      <ToggleSwitch v-model="draft.enabled" label="编排器" :disabled="!groupEnabled" />
      <p v-if="groupEnabled && !draft.enabled" class="py-3 text-xs leading-5 text-mute">使用规则匹配回复</p>
      <p v-else-if="groupEnabled" class="py-3 text-xs leading-5 text-mute">每个群每分钟最多主动回复 1 次</p>
    </div>
    <fieldset
      class="grid gap-5 sm:grid-cols-2"
      :class="{ 'opacity-50': !groupEnabled || !draft.enabled }"
      :disabled="!groupEnabled || !draft.enabled"
    >
      <ModelSelect v-model="draft.userGroupchatOrchestratorModel" :models="models" />
      <ReasoningEffortSelect v-model="draft.reasoningEffort" :model="draft.userGroupchatOrchestratorModel" :models="models" />
      <label class="field">
        <span class="field-label">消息阈值</span>
        <input v-model.number="draft.messageThreshold" class="control" type="number" min="0" max="200" step="1">
      </label>
      <label class="field">
        <span class="field-label">最近消息窗口 / ms</span>
        <input v-model.number="draft.recentMessageWindowMs" class="control" type="number" min="1000" max="3600000" step="1000">
      </label>
      <label class="field sm:col-span-2">
        <span class="field-label">提示词文件</span>
        <input v-model.trim="draft.promptFile" class="control" type="text">
        <RouterLink class="font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/orchestrator.user-group">编辑正文 →</RouterLink>
      </label>
    </fieldset>
  </section>
</template>
