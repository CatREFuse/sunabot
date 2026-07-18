<script setup lang="ts">
import { computed } from "vue";
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";
import type { ConfigSectionValueMap, ModelCatalogItem, ProviderConfig } from "../../types";

const draft = defineModel<ConfigSectionValueMap["tone"]>({ required: true });
const props = defineProps<{
  models: readonly ModelCatalogItem[];
  providers: readonly ProviderConfig[];
}>();
const enabledProviders = computed(() => props.providers.filter((provider) => provider.enabled));
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">语气处理</h2>
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.enabled" data-config-field="tone.enabled" label="启用语气处理" />
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">Provider</span>
        <select v-model="draft.providerId" class="control" data-config-field="tone.providerId">
          <option value="">跟随默认 Provider</option>
          <option v-for="provider in enabledProviders" :key="provider.id" :value="provider.id">
            {{ provider.label }}
          </option>
        </select>
      </label>
      <ModelSelect v-model="draft.model" :models="models" data-config-field="tone.model" />
      <ReasoningEffortSelect v-model="draft.reasoningEffort" :model="draft.model" :models="models" data-config-field="tone.reasoningEffort" />
      <label class="field">
        <span class="field-label">随机性（Temperature）</span>
        <SettingsConfirmInput v-model.number="draft.temperature" data-config-field="tone.temperature" type="number" min="0" max="2" step="0.1" confirm-label="确认随机性" />
      </label>
      <label class="field">
        <span class="field-label">最大输出 Token</span>
        <SettingsConfirmInput v-model.number="draft.maxOutputTokens" data-config-field="tone.maxOutputTokens" type="number" min="1" max="1000000" step="1" confirm-label="确认最大输出 Token" />
      </label>
      <label class="field">
        <span class="field-label">失败重试次数</span>
        <SettingsConfirmInput v-model.number="draft.maxRetries" data-config-field="tone.maxRetries" type="number" min="0" max="10" step="1" confirm-label="确认失败重试次数" />
      </label>
    </div>
    <div class="border-t border-line pt-6">
      <h3 class="text-base font-medium text-display">提示词</h3>
      <RouterLink class="mt-3 inline-block font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/conversation.tone-rewrite">编辑正文 →</RouterLink>
    </div>
  </section>
</template>
