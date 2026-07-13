<script setup lang="ts">
import { computed, reactive, shallowRef, toRaw, watch } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import type { ConfigSectionValueMap, ModelCatalogItem, ProviderConfig } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ModelSelect from "./ModelSelect.vue";
import ReasoningEffortSelect from "./ReasoningEffortSelect.vue";
import CodexSubscriptionAuth from "./CodexSubscriptionAuth.vue";
import ProviderCreateDialog from "./ProviderCreateDialog.vue";
import { compatibleProvider, providerPreset, providerType, type ProviderKind } from "./providerPresets";

const draft = defineModel<ConfigSectionValueMap["providers"]>({ required: true });
const props = defineProps<{ models: readonly ModelCatalogItem[]; fieldStates?: Record<string, { secretConfigured?: boolean }> }>();
const selectedIndex = shallowRef(0);
const status = shallowRef("");
const statusKind = shallowRef<"" | "success" | "error" | "warning">("");
const testing = shallowRef(false);
const loadingModels = shallowRef(false);
const probingVision = shallowRef(false);
const createOpen = shallowRef(false);
const discoveredModels = reactive<Record<string, string[]>>({});
const providerLimitReached = computed(() => draft.value.items.length >= 64);
const current = computed(() => draft.value.items[selectedIndex.value]);
const currentType = computed(() => current.value ? providerType(current.value.kind) : null);
const currentIsDefault = computed(() => Boolean(current.value && draft.value.defaultProviderId === current.value.id));
const currentEnabledDescription = computed(() => currentIsDefault.value ? "默认" : "");
const enabledProviders = computed(() => draft.value.items.filter((provider) => provider.enabled));
const visionProviders = computed(() => draft.value.items.filter((provider) => provider.enabled
  && provider.id !== current.value?.id
  && provider.multimodal !== "disabled"
  && !(provider.multimodal === "auto" && provider.detectedMultimodal === false)));
const secretConfigured = computed(() => {
  const provider = current.value;
  return provider ? props.fieldStates?.[`providers.items.${provider.id}.apiKeyEnv`]?.secretConfigured : undefined;
});
const effectiveNonVision = computed(() => current.value?.multimodal === "disabled"
  || (current.value?.multimodal === "auto" && current.value.detectedMultimodal === false));
const remoteModelItems = computed<ModelCatalogItem[]>(() => {
  const provider = current.value;
  if (!provider) return [];
  const ids = discoveredModels[provider.id]
    ?? (provider.kind === "codex-responses" ? props.models.map((model) => model.id) : [provider.model]);
  return [...new Set(ids.filter(Boolean))].map((id) => props.models.find((model) => model.id === id) ?? ({
    id,
    label: id,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
  }));
});

function supportsReasoningEffort(kind: ProviderKind) {
  return kind === "codex-responses" || kind === "openai-official";
}

watch(() => draft.value.items.length, (length) => {
  if (selectedIndex.value >= length) selectedIndex.value = Math.max(0, length - 1);
});
watch(() => current.value?.id, () => {
  if (!current.value) return;
  current.value.modelSource ??= compatibleProvider(current.value.kind) ? "custom" : "remote";
  current.value.multimodal ??= "auto";
}, { immediate: true });
watch(() => current.value ? {
  id: current.value.id,
  model: current.value.model,
  baseUrl: current.value.baseUrl,
  apiKeyEnv: current.value.apiKeyEnv
} : null, (next, previous) => {
  if (!next || !previous || next.id !== previous.id) return;
  current.value!.detectedMultimodal = undefined;
});

function beginAdd() {
  if (providerLimitReached.value) return setStatus("最多可添加 64 个 Provider", "warning");
  createOpen.value = true;
}

function createProvider(kind: ProviderKind) {
  const id = uniqueId(kind.replace(/-(official|compatible|responses)$/, "") || "provider");
  draft.value.items.push(providerPreset(kind, id));
  selectedIndex.value = draft.value.items.length - 1;
  if (!draft.value.defaultProviderId) draft.value.defaultProviderId = id;
  createOpen.value = false;
  setStatus("Provider 已添加", "success");
}

function copyProvider() {
  const provider = current.value;
  if (!provider || providerLimitReached.value) return;
  const copy = plainProvider(provider);
  copy.id = uniqueId(`${provider.id}-copy`);
  copy.label = `${provider.label} 副本`;
  draft.value.items.push(copy);
  selectedIndex.value = draft.value.items.length - 1;
  setStatus("Provider 已复制", "success");
}

function deleteProvider() {
  const provider = current.value;
  if (!provider) return;
  if (draft.value.items.length <= 1) return setStatus("至少保留一个 Provider", "error");
  if (draft.value.defaultProviderId === provider.id) return setStatus("请先选择新的默认 Provider", "warning");
  draft.value.items.splice(selectedIndex.value, 1);
  setStatus("Provider 已删除", "success");
}

function chooseModelSource(source: "remote" | "custom") {
  if (!current.value) return;
  current.value.modelSource = source;
  if (source === "remote" && !discoveredModels[current.value.id] && current.value.kind !== "codex-responses") void loadModels();
}

async function loadModels() {
  const provider = current.value;
  if (!provider) return;
  loadingModels.value = true;
  setStatus("正在读取模型", "");
  try {
    const result = await apiRequest<{ models: string[] }>("/api/providers/models", {
      method: "POST",
      body: JSON.stringify({ provider: plainProvider(provider) })
    });
    discoveredModels[provider.id] = result.models;
    if (!result.models.includes(provider.model) && result.models[0]) provider.model = result.models[0];
    setStatus(`已读取 ${result.models.length} 个模型`, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "模型读取失败", "error");
  } finally {
    loadingModels.value = false;
  }
}

async function probeVision() {
  const provider = current.value;
  if (!provider) return;
  probingVision.value = true;
  setStatus("正在探测图片能力", "");
  try {
    const result = await apiRequest<{ multimodal: boolean; reason?: string }>("/api/providers/vision-probe", {
      method: "POST",
      body: JSON.stringify({ provider: plainProvider(provider) })
    });
    provider.detectedMultimodal = result.multimodal;
    setStatus(result.multimodal ? "支持图片" : `仅文本${result.reason ? ` · ${result.reason}` : ""}`, result.multimodal ? "success" : "warning");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "探测失败", "error");
  } finally {
    probingVision.value = false;
  }
}

async function testProvider() {
  const provider = current.value;
  if (!provider) return;
  testing.value = true;
  setStatus("正在测试连接", "");
  try {
    const result = await apiRequest<{ model?: string; durationMs?: number; elapsedMs?: number; multimodal?: boolean }>("/api/providers/test", {
      method: "POST",
      body: JSON.stringify({ provider: plainProvider(provider) })
    });
    if (provider.multimodal === "auto" && result.multimodal != null) provider.detectedMultimodal = result.multimodal;
    const duration = result.durationMs ?? result.elapsedMs;
    setStatus(`连接成功 · ${result.model ?? provider.model}${duration != null ? ` · ${duration} ms` : ""}`, "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "连接失败", "error");
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
    <div><h2 class="section-title">模型服务</h2></div>

    <label class="field max-w-xl">
      <span class="field-label">默认 Provider</span>
      <select v-model="draft.defaultProviderId" class="control">
        <option v-for="provider in enabledProviders" :key="provider.id" :value="provider.id">{{ provider.label }} · {{ provider.id }}</option>
      </select>
    </label>

    <div class="grid min-w-0 gap-6 xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside class="min-w-0 border-y border-line xl:border-y-0 xl:border-r xl:pr-5">
        <div class="flex items-center justify-between py-3"><span class="field-label">Provider 列表</span><button class="icon-btn" type="button" aria-label="新增 Provider" :disabled="providerLimitReached" @click="beginAdd"><i class="bx bx-plus text-xl" aria-hidden="true"></i></button></div>
        <div class="max-h-72 overflow-y-auto xl:max-h-none">
          <button v-for="(provider, index) in draft.items" :key="provider.id" class="flex min-h-16 w-full min-w-0 items-center gap-3 border-t border-line px-2 text-left first:border-t-0" :class="selectedIndex === index ? 'bg-raised text-display' : 'text-mute'" type="button" @click="selectedIndex = index">
            <i class="bx shrink-0 text-xl" :class="providerType(provider.kind).icon" aria-hidden="true"></i>
            <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-normal">{{ provider.label }}</strong><small class="block truncate font-mono text-[9px] text-disabled">{{ providerType(provider.kind).label }} · {{ provider.id }}</small></span>
            <i class="bx text-sm" :class="provider.enabled ? 'bx-check-circle text-success' : 'bx-minus-circle text-disabled'" aria-hidden="true"></i>
          </button>
        </div>
      </aside>

      <div v-if="current" class="grid min-w-0 gap-2">
        <header class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
          <div class="min-w-0"><h3 class="truncate text-lg font-medium text-display">{{ current.label || "未命名" }}</h3><p class="mt-1 truncate font-mono text-[10px] text-mute">{{ current.model || "未选择模型" }}</p></div>
          <div class="flex gap-2"><button class="icon-btn" type="button" aria-label="复制 Provider" @click="copyProvider"><i class="bx bx-copy text-lg" aria-hidden="true"></i></button><button class="icon-btn text-accent" type="button" aria-label="删除 Provider" @click="deleteProvider"><i class="bx bx-trash text-lg" aria-hidden="true"></i></button></div>
        </header>

        <CodexSubscriptionAuth v-if="current.kind === 'codex-responses'" class="mt-4" />

        <section class="provider-group">
          <header><i class="bx bx-id-card" aria-hidden="true"></i><div><strong>身份</strong><span>名称与 ID</span></div></header>
          <div class="grid gap-5 sm:grid-cols-2">
            <label class="field"><span class="field-label">ID</span><input :value="current.id" class="control" type="text" readonly></label>
            <label class="field"><span class="field-label">名称</span><input v-model.trim="current.label" class="control" type="text" autocomplete="off"></label>
          </div>
          <ToggleSwitch v-model="current.enabled" label="启用" :disabled="currentIsDefault" :description="currentEnabledDescription" />
        </section>

        <section class="provider-group">
          <header><i class="bx bx-link" aria-hidden="true"></i><div><strong>连接</strong><span>{{ currentType?.description }}</span></div></header>
          <div class="grid gap-5 sm:grid-cols-2">
            <label class="field"><span class="field-label">类型</span><span class="control flex items-center gap-2 !bg-raised" aria-label="Provider 类型"><i class="bx" :class="currentType?.icon" aria-hidden="true"></i>{{ currentType?.label }}</span></label>
            <label class="field"><span class="field-label flex items-center justify-between gap-3"><span>API Key 环境变量</span><small v-if="secretConfigured != null" class="font-mono text-[10px]" :class="secretConfigured ? 'text-success' : 'text-warning'">{{ secretConfigured ? "已配置" : "未配置" }}</small></span><input v-model.trim="current.apiKeyEnv" class="control" type="text" autocomplete="off"></label>
            <label class="field sm:col-span-2"><span class="field-label flex items-center justify-between gap-3"><span>Base URL</span><small v-if="!compatibleProvider(current.kind)" class="font-mono text-[10px] text-mute">固定</small></span><input v-model.trim="current.baseUrl" class="control" type="url" :readonly="!compatibleProvider(current.kind)" autocomplete="off"></label>
          </div>
        </section>

        <section class="provider-group">
          <header><i class="bx bx-chip" aria-hidden="true"></i><div><strong>模型</strong><span>模型 ID</span></div></header>
          <div class="flex flex-wrap items-center gap-2">
            <div class="segmented" aria-label="模型来源"><button class="segmented-button" type="button" :aria-pressed="current.modelSource !== 'custom'" @click="chooseModelSource('remote')">远程目录</button><button class="segmented-button" type="button" :aria-pressed="current.modelSource === 'custom'" @click="chooseModelSource('custom')">自定义 ID</button></div>
            <button v-if="current.modelSource !== 'custom'" class="btn btn-ghost" type="button" :disabled="loadingModels" @click="loadModels"><i class="bx bx-refresh" :class="loadingModels ? 'bx-spin' : ''" aria-hidden="true"></i>拉取模型</button>
          </div>
          <div class="grid gap-5 sm:grid-cols-2">
            <ModelSelect v-if="current.modelSource !== 'custom'" v-model="current.model" :models="remoteModelItems" />
            <label v-else class="field"><span class="field-label">模型</span><input v-model.trim="current.model" class="control" type="text" aria-label="模型" autocomplete="off"></label>
            <ReasoningEffortSelect v-if="supportsReasoningEffort(current.kind)" v-model="current.reasoningEffort" :model="current.model" :models="props.models" />
            <label v-if="current.kind === 'codex-responses' || current.kind === 'openai-official'" class="field"><span class="field-label">图像模型</span><input v-model.trim="current.imageModel" class="control" type="text" autocomplete="off"></label>
          </div>
        </section>

        <section class="provider-group">
          <header><i class="bx bx-image-alt" aria-hidden="true"></i><div><strong>多模态</strong><span>图片能力</span></div></header>
          <div class="grid gap-5 sm:grid-cols-2">
            <label class="field"><span class="field-label">图片能力</span><select v-model="current.multimodal" class="control"><option value="auto">自动探测</option><option value="enabled">支持图片</option><option value="disabled">仅文本</option></select></label>
            <div class="field"><span class="field-label">探测结果</span><button class="btn justify-self-start" type="button" :disabled="probingVision" @click="probeVision"><i class="bx bx-scan" aria-hidden="true"></i>{{ probingVision ? "探测中" : "探测多模态" }}</button><small v-if="current.detectedMultimodal != null" class="font-mono text-[10px]" :class="current.detectedMultimodal ? 'text-success' : 'text-warning'">{{ current.detectedMultimodal ? "支持图片" : "仅文本" }}</small></div>
            <template v-if="effectiveNonVision">
              <label class="field"><span class="field-label">读图辅助 Provider</span><select v-model="current.visionProviderId" class="control"><option value="">选择 Provider</option><option v-for="provider in visionProviders" :key="provider.id" :value="provider.id">{{ provider.label }}</option></select></label>
              <label class="field"><span class="field-label">读图模型</span><input v-model.trim="current.visionModel" class="control" type="text" placeholder="留空使用默认模型"></label>
            </template>
          </div>
        </section>

        <section class="provider-group">
          <header><i class="bx bx-slider-alt" aria-hidden="true"></i><div><strong>生成参数</strong><span>输出参数</span></div></header>
          <div class="grid gap-5 sm:grid-cols-2"><label class="field"><span class="field-label">随机性（Temperature）</span><input v-model.number="current.temperature" class="control" type="number" min="0" max="2" step="0.1"></label><label class="field"><span class="field-label">最大输出 Token</span><input v-model.number="current.maxOutputTokens" class="control" type="number" min="1" max="1000000" step="1"></label></div>
        </section>

        <footer class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5"><span class="inline-state max-w-full break-words" :data-kind="statusKind || undefined">{{ status }}</span><button class="btn" type="button" :disabled="testing" @click="testProvider"><i class="bx bx-plug" aria-hidden="true"></i>{{ testing ? "测试中" : "测试连接" }}</button></footer>
      </div>
    </div>

    <ProviderCreateDialog :open="createOpen" @close="createOpen = false" @select="createProvider" />
  </section>
</template>

<style scoped>
.provider-group { display: grid; gap: 20px; border-bottom: 1px solid rgb(var(--color-line)); padding: 28px 0; }
.provider-group > header { display: flex; align-items: center; gap: 12px; }
.provider-group > header > i { width: 40px; flex: none; color: rgb(var(--color-interactive)); font-size: 28px; line-height: 40px; text-align: center; }
.provider-group > header strong { display: block; color: rgb(var(--color-display)); font-size: 15px; font-weight: 500; }
.provider-group > header span { display: block; margin-top: 2px; color: rgb(var(--color-mute)); font-size: 12px; }
</style>
