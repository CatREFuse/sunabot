<script setup lang="ts">
import { Copy, Plus, Trash2 } from "lucide-vue-next";
import { computed, shallowRef, toRaw, watch } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import type { ConfigSectionValueMap, ModelCatalogItem, ProviderConfig } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import CodexSubscriptionAuth from "./CodexSubscriptionAuth.vue";

const draft = defineModel<ConfigSectionValueMap["providers"]>({ required: true });
const props = defineProps<{ models: readonly ModelCatalogItem[]; fieldStates?: Record<string, { secretConfigured?: boolean }> }>();
const selectedIndex = shallowRef(0);
const status = shallowRef("");
const statusKind = shallowRef<"" | "success" | "error" | "warning">("");
const testing = shallowRef(false);
const imageChoice = shallowRef("catalog");
const providerLimitReached = computed(() => draft.value.items.length >= 64);
const current = computed(() => draft.value.items[selectedIndex.value]);
const enabledProviders = computed(() => draft.value.items.filter((provider) => provider.enabled));
const secretConfigured = computed(() => {
  const provider = current.value;
  if (!provider) return undefined;
  return props.fieldStates?.[`providers.items.${provider.id}.apiKeyEnv`]?.secretConfigured;
});

watch(
  () => draft.value.items.length,
  (length) => {
    if (selectedIndex.value >= length) selectedIndex.value = Math.max(0, length - 1);
  }
);
watch(() => current.value?.imageModel, (value) => (imageChoice.value = value === "gpt-image-2" ? "catalog" : "custom"), { immediate: true });

function addProvider() {
  if (providerLimitReached.value) {
    setStatus("[最多 64 个 Provider]", "warning");
    return;
  }
  const id = uniqueId("provider");
  draft.value.items.push({
    id,
    label: "新 Provider",
    kind: "codex-responses",
    enabled: true,
    model: "gpt-5.6-sol",
    imageModel: "gpt-image-2",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKeyEnv: "OPENAI_API_KEY",
    envFile: "",
    temperature: 0.7,
    maxOutputTokens: 8192,
    reasoningEffort: "low"
  });
  selectedIndex.value = draft.value.items.length - 1;
  if (!draft.value.defaultProviderId) draft.value.defaultProviderId = id;
  setStatus("[PROVIDER ADDED]", "success");
}

function applyOfficialPreset(kind: "gemini" | "anthropic") {
  const provider = current.value;
  if (!provider) return;
  if (kind === "gemini") {
    provider.kind = "gemini-openai";
    provider.label = "Google Gemini";
    provider.model = "gemini-3.5-flash";
    provider.baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    provider.apiKeyEnv = "GEMINI_API_KEY";
    provider.temperature = 0.7;
  } else {
    provider.kind = "anthropic-openai";
    provider.label = "Anthropic Claude";
    provider.model = "claude-sonnet-4-6";
    provider.baseUrl = "https://api.anthropic.com/v1";
    provider.apiKeyEnv = "ANTHROPIC_API_KEY";
    provider.temperature = Math.min(provider.temperature, 1);
  }
  provider.envFile = "workspace/secrets/runtime.env";
  setStatus(`[${kind.toUpperCase()} OFFICIAL PRESET]`, "success");
}

function copyProvider() {
  const provider = current.value;
  if (!provider) return;
  if (providerLimitReached.value) {
    setStatus("[最多 64 个 Provider]", "warning");
    return;
  }
  const copy = plainProvider(provider);
  copy.id = uniqueId(`${provider.id}-copy`);
  copy.label = `${provider.label} 副本`;
  draft.value.items.push(copy);
  selectedIndex.value = draft.value.items.length - 1;
  setStatus("[PROVIDER COPIED]", "success");
}

function deleteProvider() {
  const provider = current.value;
  if (!provider) return;
  if (draft.value.items.length <= 1) {
    setStatus("[至少保留一个 Provider]", "error");
    return;
  }
  if (draft.value.defaultProviderId === provider.id) {
    setStatus("[请先选择新的默认 Provider]", "warning");
    return;
  }
  draft.value.items.splice(selectedIndex.value, 1);
  setStatus("[PROVIDER DELETED]", "success");
}

function updateId(event: Event) {
  const provider = current.value;
  if (!provider) return;
  const previous = provider.id;
  const next = (event.target as HTMLInputElement).value;
  provider.id = next;
  if (draft.value.defaultProviderId === previous) draft.value.defaultProviderId = next;
}

function setImageChoice(event: Event) {
  const provider = current.value;
  if (!provider) return;
  const value = (event.target as HTMLSelectElement).value;
  imageChoice.value = value;
  if (value === "catalog") provider.imageModel = "gpt-image-2";
  else if (provider.imageModel === "gpt-image-2") provider.imageModel = "";
}

async function testProvider() {
  const provider = current.value;
  if (!provider) return;
  testing.value = true;
  setStatus("[TESTING...]", "");
  try {
    const result = await apiRequest<{ ok: boolean; model?: string; durationMs?: number; elapsedMs?: number }>("/api/providers/test", {
      method: "POST",
      body: JSON.stringify({ provider: plainProvider(provider) })
    });
    const duration = result.durationMs ?? result.elapsedMs;
    setStatus(`[CONNECTED · ${result.model ?? provider.model}${duration != null ? ` · ${duration}MS` : ""}]`, "success");
  } catch (error) {
    setStatus(`[ERROR: ${error instanceof Error ? error.message : "连接失败"}]`, "error");
  } finally {
    testing.value = false;
  }
}

function uniqueId(base: string) {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let value = normalized;
  let counter = 2;
  while (draft.value.items.some((item) => item.id === value)) value = `${normalized}-${counter++}`;
  return value;
}

function plainProvider(provider: ProviderConfig) {
  return JSON.parse(JSON.stringify(toRaw(provider))) as ProviderConfig;
}

function setStatus(message: string, kind: "" | "success" | "error" | "warning") {
  status.value = message;
  statusKind.value = kind;
}
</script>

<template>
  <section class="grid gap-8">
    <CodexSubscriptionAuth />
    <div>
      <p class="page-kicker">PROVIDERS</p>
      <h2 class="section-title mt-2">模型服务</h2>
    </div>

    <label class="field max-w-xl">
      <span class="field-label">默认 Provider</span>
      <select v-model="draft.defaultProviderId" class="control">
        <option v-for="provider in enabledProviders" :key="provider.id" :value="provider.id">{{ provider.label }} · {{ provider.id }}</option>
      </select>
    </label>

    <div class="grid min-w-0 gap-6 xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside class="min-w-0 border-y border-line xl:border-y-0 xl:border-r xl:pr-5">
        <div class="flex items-center justify-between py-3">
          <span class="field-label">Provider 列表</span>
          <button class="icon-btn" type="button" title="新增 Provider" aria-label="新增 Provider" :disabled="providerLimitReached" @click="addProvider">
            <Plus :size="17" :stroke-width="1.5" aria-hidden="true" />
          </button>
        </div>
        <div class="max-h-72 overflow-y-auto xl:max-h-none">
          <button
            v-for="(provider, index) in draft.items"
            :key="`${index}-${provider.id}`"
            class="flex min-h-14 w-full min-w-0 items-center gap-3 border-t border-line px-2 text-left first:border-t-0"
            :class="selectedIndex === index ? 'bg-raised text-display' : 'text-mute'"
            type="button"
            @click="selectedIndex = index"
          >
            <span class="shrink-0 font-mono text-[10px]" :class="provider.enabled ? 'text-success' : 'text-disabled'">{{ provider.enabled ? "ON" : "OFF" }}</span>
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-sm font-normal">{{ provider.label }}</strong>
              <small class="block truncate font-mono text-[10px] text-disabled">{{ provider.id }}</small>
            </span>
            <span v-if="draft.defaultProviderId === provider.id" class="font-mono text-[10px] text-mute">DEFAULT</span>
          </button>
        </div>
      </aside>

      <div v-if="current" class="grid min-w-0 gap-6">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <div>
            <strong class="text-lg font-medium text-display">{{ current.label || "未命名" }}</strong>
            <p class="mt-1 font-mono text-[10px] text-mute">{{ current.model || "NO MODEL" }}</p>
          </div>
          <div class="flex gap-2">
            <button class="icon-btn" type="button" title="复制" aria-label="复制 Provider" :disabled="providerLimitReached" @click="copyProvider"><Copy :size="17" :stroke-width="1.5" /></button>
            <button class="icon-btn text-accent" type="button" title="删除" aria-label="删除 Provider" @click="deleteProvider"><Trash2 :size="17" :stroke-width="1.5" /></button>
          </div>
        </div>

        <div class="rounded-lg border border-line px-4 py-2">
          <ToggleSwitch v-model="current.enabled" label="启用 Provider" :disabled="draft.defaultProviderId === current.id" description="默认 Provider 必须保持启用" />
        </div>

        <div class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised p-3">
          <span class="mr-auto font-mono text-[10px] text-mute">OFFICIAL BASE URL PRESETS</span>
          <button class="btn btn-ghost" type="button" @click="applyOfficialPreset('gemini')">Google Gemini</button>
          <button class="btn btn-ghost" type="button" @click="applyOfficialPreset('anthropic')">Anthropic Claude</button>
        </div>

        <div class="grid gap-5 sm:grid-cols-2">
          <label class="field">
            <span class="field-label">ID</span>
            <input :value="current.id" class="control" type="text" autocomplete="off" @input="updateId">
          </label>
          <label class="field">
            <span class="field-label">名称</span>
            <input v-model.trim="current.label" class="control" type="text" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">协议</span>
            <select v-model="current.kind" class="control">
              <option value="codex-responses">codex-responses</option>
              <option value="openai-responses">openai-responses</option>
              <option value="gemini-openai">gemini-openai</option>
              <option value="anthropic-openai">anthropic-openai</option>
            </select>
          </label>
          <ModelSelect v-model="current.model" :models="models" />
          <ReasoningEffortSelect v-model="current.reasoningEffort" :model="current.model" :models="models" />
          <div class="field">
            <span class="field-label">图像模型</span>
            <label class="field"><span class="sr-only">图像模型类型</span><select :value="imageChoice" class="control" aria-label="图像模型" @change="setImageChoice"><option value="catalog">gpt-image-2</option><option value="custom">自定义</option></select></label>
            <label v-if="imageChoice === 'custom'" class="field"><span class="sr-only">自定义图像模型 ID</span><input v-model.trim="current.imageModel" class="control" type="text" placeholder="输入图像模型 ID" aria-label="自定义图像模型 ID"></label>
          </div>
          <label class="field sm:col-span-2">
            <span class="field-label">Base URL</span>
            <input v-model.trim="current.baseUrl" class="control" type="url" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">API Key Env</span>
            <input v-model.trim="current.apiKeyEnv" class="control" type="text" autocomplete="off">
            <small v-if="secretConfigured != null" class="font-mono text-[10px]" :class="secretConfigured ? 'text-success' : 'text-warning'">{{ secretConfigured ? "[CONFIGURED]" : "[MISSING]" }}</small>
          </label>
          <label class="field">
            <span class="field-label">Env File</span>
            <input v-model.trim="current.envFile" class="control" type="text" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">Temperature</span>
            <input v-model.number="current.temperature" class="control" type="number" min="0" max="2" step="0.1">
          </label>
          <label class="field">
            <span class="field-label">Max Output Tokens</span>
            <input v-model.number="current.maxOutputTokens" class="control" type="number" min="1" max="1000000" step="1">
          </label>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <span class="inline-state" :data-kind="statusKind || undefined">{{ status }}</span>
          <button class="btn" type="button" :disabled="testing" @click="testProvider">{{ testing ? "测试中" : "测试连接" }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
