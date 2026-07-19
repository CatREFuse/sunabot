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
  defaultProviderId: string;
  mainMaxRetries: number;
}>();
const enabledProviders = computed(() => props.providers.filter((provider) => provider.enabled));
const followsMainModel = computed(() => draft.value.followMainModel);
const mainProvider = computed(() => (
  props.providers.find((provider) => provider.id === props.defaultProviderId)
  ?? props.providers.find((provider) => provider.enabled)
  ?? props.providers[0]
));
const displayedProviderId = computed({
  get: () => followsMainModel.value ? mainProvider.value?.id ?? "" : draft.value.providerId,
  set: (value: string) => { if (!followsMainModel.value) draft.value.providerId = value; }
});
const displayedModel = computed({
  get: () => followsMainModel.value ? mainProvider.value?.model ?? draft.value.model : draft.value.model,
  set: (value: string) => { if (!followsMainModel.value) draft.value.model = value; }
});
const displayedReasoningEffort = computed({
  get: () => followsMainModel.value
    ? mainProvider.value?.reasoningEffort ?? draft.value.reasoningEffort
    : draft.value.reasoningEffort,
  set: (value) => { if (!followsMainModel.value) draft.value.reasoningEffort = value; }
});
const displayedTemperature = computed({
  get: () => followsMainModel.value ? mainProvider.value?.temperature ?? draft.value.temperature : draft.value.temperature,
  set: (value: number) => { if (!followsMainModel.value) draft.value.temperature = value; }
});
const displayedMaxOutputTokens = computed({
  get: () => followsMainModel.value ? mainProvider.value?.maxOutputTokens ?? draft.value.maxOutputTokens : draft.value.maxOutputTokens,
  set: (value: number) => { if (!followsMainModel.value) draft.value.maxOutputTokens = value; }
});
const displayedMaxRetries = computed({
  get: () => followsMainModel.value ? props.mainMaxRetries : draft.value.maxRetries,
  set: (value: number) => { if (!followsMainModel.value) draft.value.maxRetries = value; }
});
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">语气处理</h2>
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.enabled" data-config-field="tone.enabled" label="启用语气处理" />
      <ToggleSwitch v-model="draft.followMainModel" data-config-field="tone.followMainModel" label="主模型跟随" />
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">Provider</span>
        <select v-model="displayedProviderId" class="control" data-config-field="tone.providerId" :disabled="followsMainModel">
          <option value="">跟随默认 Provider</option>
          <option v-for="provider in enabledProviders" :key="provider.id" :value="provider.id">
            {{ provider.label }}
          </option>
        </select>
      </label>
      <ModelSelect v-model="displayedModel" :models="models" :disabled="followsMainModel" data-config-field="tone.model" />
      <ReasoningEffortSelect v-model="displayedReasoningEffort" :model="displayedModel" :models="models" :disabled="followsMainModel" data-config-field="tone.reasoningEffort" />
      <label class="field">
        <span class="field-label">随机性（Temperature）</span>
        <SettingsConfirmInput v-model.number="displayedTemperature" :disabled="followsMainModel" data-config-field="tone.temperature" type="number" min="0" max="2" step="0.1" confirm-label="确认随机性" />
      </label>
      <label class="field">
        <span class="field-label">最大输出 Token</span>
        <SettingsConfirmInput v-model.number="displayedMaxOutputTokens" :disabled="followsMainModel" data-config-field="tone.maxOutputTokens" type="number" min="1" max="1000000" step="1" confirm-label="确认最大输出 Token" />
      </label>
      <label class="field">
        <span class="field-label">失败重试次数</span>
        <SettingsConfirmInput v-model.number="displayedMaxRetries" :disabled="followsMainModel" data-config-field="tone.maxRetries" type="number" min="0" max="10" step="1" confirm-label="确认失败重试次数" />
      </label>
    </div>
    <div class="border-t border-line pt-6">
      <h3 class="text-base font-medium text-display">提示词</h3>
      <RouterLink class="mt-3 inline-block font-mono text-[11px] text-[rgb(var(--color-interactive))]" to="/system-prompts/conversation.tone-rewrite">编辑正文 →</RouterLink>
    </div>
  </section>
</template>
