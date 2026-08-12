<script setup lang="ts">
import { shallowRef } from "vue";
import {
  type AgentConfigImportPayload,
  useAgentConfigImport
} from "../../composables/useAgentConfigImport";

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ change: [payload: AgentConfigImportPayload | undefined] }>();
const folderInput = shallowRef<HTMLInputElement>();
const zipInput = shallowRef<HTMLInputElement>();
const importer = useAgentConfigImport();

async function chooseFolder(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;
  try {
    emit("change", await importer.selectFolder(files));
  } catch {
    emit("change", undefined);
  } finally {
    if (folderInput.value) folderInput.value.value = "";
  }
}

async function chooseZip(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  try {
    emit("change", await importer.selectZip(file));
  } catch {
    emit("change", undefined);
  } finally {
    if (zipInput.value) zipInput.value.value = "";
  }
}

function clear() {
  importer.clear();
  emit("change", undefined);
}
</script>

<template>
  <section class="field" aria-labelledby="agent-import-title">
    <div class="flex items-center justify-between gap-4">
      <span id="agent-import-title" class="field-label">导入现有配置</span>
      <button v-if="importer.preview.value" class="text-xs text-mute underline" type="button" :disabled="props.disabled" @click="clear">清除</button>
    </div>
    <p class="mt-2 text-xs leading-5 text-mute">选择配置文件夹或 ZIP。缺失内容会使用当前默认配置补齐。</p>
    <div class="mt-3 flex flex-wrap gap-3">
      <label class="btn min-h-10 cursor-pointer px-4" :class="{ 'pointer-events-none opacity-50': props.disabled || importer.loading.value }">
        <span>{{ importer.loading.value ? "校验中" : "选择文件夹" }}</span>
        <input ref="folderInput" class="sr-only" type="file" multiple webkitdirectory directory :disabled="props.disabled || importer.loading.value" @change="chooseFolder">
      </label>
      <label class="btn min-h-10 cursor-pointer px-4" :class="{ 'pointer-events-none opacity-50': props.disabled || importer.loading.value }">
        <span>选择 ZIP</span>
        <input ref="zipInput" class="sr-only" type="file" accept=".zip,application/zip" :disabled="props.disabled || importer.loading.value" @change="chooseZip">
      </label>
    </div>
    <p v-if="importer.error.value" class="mt-3 text-sm text-accent" role="alert">{{ importer.error.value }}</p>
    <div v-if="importer.preview.value" class="mt-4 border-t border-line pt-4">
      <p class="text-sm text-display">已校验 {{ importer.preview.value.included.length }} 个文件</p>
      <p v-if="importer.preview.value.missing.length" class="mt-2 text-xs leading-5 text-mute">将使用默认配置补齐：{{ importer.preview.value.missing.join("、") }}</p>
    </div>
  </section>
</template>
