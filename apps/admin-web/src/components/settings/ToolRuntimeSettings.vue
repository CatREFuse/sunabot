<script setup lang="ts">
import { computed } from "vue";
import type {
  ConfigEnvelope,
  ConfigSectionValueMap,
  ImageQuality,
  ImageResolution,
  ImageSize,
  ModelCatalogItem
} from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import TavilyKeyPool from "./TavilyKeyPool.vue";

const draft = defineModel<ConfigSectionValueMap["tools"]>({ required: true });
const props = defineProps<{
  models: readonly ModelCatalogItem[];
  fieldStates?: ConfigEnvelope["fieldStates"];
}>();
const tavilyFieldState = computed(() => props.fieldStates?.["bot.tools.websearch.tavilyApiKeys"]);
const sizes: ImageSize[] = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840"];
const resolutions: ImageResolution[] = ["1K", "2K", "4K"];
const qualities: Array<{ value: ImageQuality; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" }
];
</script>

<template>
  <section class="grid gap-10" aria-label="运行参数">
    <label class="field max-w-xs">
      <span class="field-label">单轮工具调用上限</span>
      <input v-model.number="draft.maxCalls" class="control" type="number" min="1" max="100" step="1">
      <small class="text-xs text-mute">每次 Agent 行动最多调用 {{ draft.maxCalls }} 次工具</small>
    </label>

    <section class="grid gap-5 border-t border-line pt-7">
      <div>
        <h3 class="section-title">网页搜索</h3>
      </div>
      <div class="grid gap-5 sm:grid-cols-2">
        <label class="field">
          <span class="field-label">最大结果数</span>
          <input v-model.number="draft.websearch.maxResults" class="control" type="number" min="1" max="10" step="1">
        </label>
        <TavilyKeyPool
          v-model="draft.websearch"
          class="sm:col-span-2"
          :field-state="tavilyFieldState"
        />
        <label class="field sm:col-span-2">
          <span class="field-label">Tavily Key 环境变量</span>
          <input v-model.trim="draft.websearch.tavilyApiKeyEnv" class="control" type="text" autocomplete="off">
        </label>
      </div>
    </section>

    <section class="grid gap-5 border-t border-line pt-7">
      <div>
        <h3 class="section-title">Codex 任务</h3>
      </div>
      <ToggleSwitch
        v-model="draft.codex.enabled"
        label="启动 Codex Worker"
        description="复杂本地任务、深度研究和长时间分析"
      />
      <div class="grid gap-5 sm:grid-cols-2">
        <label class="field">
          <span class="field-label">模型</span>
          <select v-model="draft.codex.model" class="control" :disabled="!draft.codex.enabled">
            <option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">可执行文件</span>
          <input v-model.trim="draft.codex.codexExecutable" class="control" type="text" autocomplete="off" placeholder="auto" :disabled="!draft.codex.enabled">
        </label>
        <label class="field">
          <span class="field-label">任务超时（毫秒）</span>
          <input v-model.number="draft.codex.timeoutMs" class="control" type="number" min="1000" max="86400000" step="1000" :disabled="!draft.codex.enabled">
        </label>
        <label class="field">
          <span class="field-label">最大并发数</span>
          <input v-model.number="draft.codex.maxConcurrency" class="control" type="number" min="1" max="16" step="1" :disabled="!draft.codex.enabled">
        </label>
      </div>
    </section>

    <section class="grid gap-5 border-t border-line pt-7">
      <div>
        <h3 class="section-title">图像生成</h3>
      </div>
      <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <label class="field">
          <span class="field-label">Provider</span>
          <select v-model="draft.generateImg.provider" class="control">
            <option value="codex-image-gen">Codex image_gen</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">默认尺寸</span>
          <select v-model="draft.generateImg.size" class="control">
            <option v-for="size in sizes" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">默认清晰度</span>
          <select v-model="draft.generateImg.resolution" class="control">
            <option v-for="resolution in resolutions" :key="resolution" :value="resolution">{{ resolution }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">默认质量</span>
          <select v-model="draft.generateImg.quality" class="control">
            <option v-for="quality in qualities" :key="quality.value" :value="quality.value">{{ quality.label }}</option>
          </select>
        </label>
      </div>
    </section>
  </section>
</template>
