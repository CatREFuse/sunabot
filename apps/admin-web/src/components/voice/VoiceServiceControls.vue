<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type {
  VoiceProviderSettings,
  VoiceProviderSettingsInput,
  VoiceProviderStatus,
  VoiceServiceAction,
} from "../../types/voice";
import { VOICE_LANGUAGES, VOICE_LANGUAGE_LABELS } from "../../types/voice";

const props = withDefaults(
  defineProps<{
    settings: VoiceProviderSettings | null;
    provider: VoiceProviderStatus | null;
    action?: VoiceServiceAction;
    saving?: boolean;
    error?: string;
    message?: string;
  }>(),
  { action: "", saving: false, error: "", message: "" },
);
const emit = defineEmits<{
  save: [input: VoiceProviderSettingsInput];
  check: [];
}>();

const draft = reactive<VoiceProviderSettings>({
  protocol: "openai-audio",
  baseUrl: "",
  apiKeyEnv: "",
  model: "",
  voices: { zh: null, en: null, ja: null },
});

watch(
  () => props.settings,
  (settings) => {
    if (!settings) return;
    draft.protocol = settings.protocol;
    draft.baseUrl = settings.baseUrl;
    draft.apiKeyEnv = settings.apiKeyEnv;
    draft.model = settings.model;
    for (const language of VOICE_LANGUAGES) {
      draft.voices[language] = settings.voices[language];
    }
  },
  { immediate: true },
);

const busy = computed(() => props.saving || props.action === "check");
const normalizedDraft = computed<VoiceProviderSettingsInput>(() => ({
  protocol: "openai-audio",
  baseUrl: draft.baseUrl.trim(),
  apiKeyEnv: draft.apiKeyEnv.trim(),
  model: draft.model.trim(),
  voices: Object.fromEntries(
    VOICE_LANGUAGES.map((language) => [
      language,
      draft.voices[language]?.trim() || null,
    ]),
  ) as VoiceProviderSettings["voices"],
}));
const invalid = computed(
  () =>
    !normalizedDraft.value.baseUrl ||
    !normalizedDraft.value.apiKeyEnv ||
    !normalizedDraft.value.model,
);
const dirty = computed(
  () =>
    Boolean(props.settings) &&
    JSON.stringify(normalizedDraft.value) !== JSON.stringify(props.settings),
);
const stateLabel = computed(() => {
  if (props.action === "check") return "检测中";
  if (!props.provider) return "未检测";
  if (props.provider.state === "unconfigured") return "未配置";
  return props.provider.ready ? "可用" : "不可用";
});
const stateKind = computed(() => {
  if (props.action === "check" || !props.provider) return undefined;
  if (props.provider.ready) return "success";
  return props.provider.state === "unavailable" ? "error" : undefined;
});
const detail = computed(() => {
  if (props.provider?.message) return props.provider.message;
  if (props.provider?.latencyMs != null)
    return `响应 ${props.provider.latencyMs} ms`;
  return "OpenAI Audio 兼容";
});

function save() {
  if (busy.value || invalid.value || !dirty.value) return;
  emit("save", normalizedDraft.value);
}
</script>

<template>
  <section aria-labelledby="voice-service-title">
    <header
      class="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-end"
    >
      <div class="min-w-0">
        <h2 id="voice-service-title" class="section-title">在线语音服务</h2>
        <p class="mt-1 text-xs leading-5 text-mute">OpenAI Audio 兼容</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <span class="inline-state mr-auto sm:mr-2" :data-kind="stateKind">
          {{ stateLabel }}
        </span>
        <button
          class="btn"
          type="button"
          :disabled="busy || !settings"
          @click="emit('check')"
        >
          <i
            class="bx"
            :class="action === 'check' ? 'bx-loader-alt bx-spin' : 'bx-pulse'"
            aria-hidden="true"
          ></i>
          {{ action === "check" ? "检测中" : "检测连接" }}
        </button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="busy || invalid || !dirty"
          @click="save"
        >
          <i
            class="bx"
            :class="saving ? 'bx-loader-alt bx-spin' : 'bx-save'"
            aria-hidden="true"
          ></i>
          {{ saving ? "保存中" : "保存设置" }}
        </button>
      </div>
    </header>

    <p class="mt-4 text-xs leading-5 text-mute">{{ detail }}</p>

    <div class="mt-6 grid gap-5 border-y border-line py-6 md:grid-cols-2">
      <label class="field md:col-span-2">
        <span class="field-label">服务地址</span>
        <input
          v-model.trim="draft.baseUrl"
          class="control"
          type="url"
          autocomplete="url"
          spellcheck="false"
          placeholder="https://api.openai.com/v1"
          :disabled="busy || !settings"
        />
      </label>
      <label class="field">
        <span class="field-label">接口协议</span>
        <select v-model="draft.protocol" class="control" disabled>
          <option value="openai-audio">OpenAI Audio 兼容</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">API Key 环境变量</span>
        <input
          v-model.trim="draft.apiKeyEnv"
          class="control font-mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="OPENAI_API_KEY"
          :disabled="busy || !settings"
        />
      </label>
      <label class="field md:col-span-2">
        <span class="field-label">模型</span>
        <input
          v-model.trim="draft.model"
          class="control font-mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="gpt-4o-mini-tts"
          :disabled="busy || !settings"
        />
      </label>

      <fieldset class="md:col-span-2">
        <legend class="field-label">语言音色</legend>
        <div class="mt-3 grid gap-4 md:grid-cols-3">
          <label
            v-for="language in VOICE_LANGUAGES"
            :key="language"
            class="field"
          >
            <span class="text-xs text-mute">{{
              VOICE_LANGUAGE_LABELS[language]
            }}</span>
            <input
              v-model.trim="draft.voices[language]"
              class="control font-mono"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="voice ID"
              :disabled="busy || !settings"
            />
          </label>
        </div>
      </fieldset>
    </div>

    <p v-if="error" class="mt-4 inline-state" data-kind="error" role="alert">
      {{ error }}
    </p>
    <p
      v-else-if="message"
      class="mt-4 inline-state"
      data-kind="success"
      aria-live="polite"
    >
      {{ message }}
    </p>
  </section>
</template>
