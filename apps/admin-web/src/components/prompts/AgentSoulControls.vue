<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import { useAgentSoul } from "../../composables/useAgentSoul";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = withDefaults(defineProps<{ agentId: string; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ imported: [] }>();
const input = useTemplateRef<HTMLInputElement>("input");
const soul = useAgentSoul(() => props.agentId);
const busy = computed(() => Boolean(soul.operation.value));
const changedCount = computed(() => soul.preview.value?.files.filter((file) => file.change === "replace").length ?? 0);

async function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  await soul.inspect(file);
  if (input.value) input.value.value = "";
}

function openFilePicker() {
  input.value?.click();
}

async function confirmImport() {
  if (await soul.apply()) emit("imported");
}
</script>

<template>
  <div class="mt-4 border-y border-line py-3">
    <div class="flex flex-wrap gap-2">
      <button class="btn min-h-10 flex-1 px-3" type="button" :disabled="props.disabled || busy" @click="soul.exportSoul">
        <i class="bx bx-download" aria-hidden="true"></i>
        {{ soul.operation.value === "export" ? "导出中" : "导出灵魂" }}
      </button>
      <button class="btn min-h-10 flex-1 px-3" type="button" :disabled="props.disabled || busy" @click="openFilePicker">
        <i class="bx bx-upload" aria-hidden="true"></i>
        {{ soul.operation.value === "preview" ? "校验中" : "导入灵魂" }}
      </button>
      <input
        ref="input"
        class="sr-only"
        type="file"
        accept=".sunabot-soul.json,application/json"
        :disabled="props.disabled || busy"
        @change="selectFile"
      >
    </div>
    <p v-if="soul.error.value" class="mt-3 text-xs text-accent" role="alert">{{ soul.error.value }}</p>
    <p v-else-if="soul.message.value" class="mt-3 text-xs text-success" role="status">{{ soul.message.value }}</p>
  </div>

  <DialogOverlay :open="Boolean(soul.preview.value)" labelledby="soul-import-title" @close="soul.resetPreview">
    <section class="flex max-h-[min(720px,calc(100vh-32px))] w-full max-w-xl flex-col border border-visible bg-panel p-5 sm:p-6">
      <div class="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div class="min-w-0">
          <h2 id="soul-import-title" class="text-xl font-medium text-display">导入灵魂</h2>
          <p class="mt-2 truncate text-sm text-mute">来源 · {{ soul.preview.value?.source.name }} · {{ soul.preview.value?.source.agentId }}</p>
          <p class="mt-1 truncate text-xs text-disabled">目标 · {{ soul.preview.value?.targetAgentId }}</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" :disabled="busy" @click="soul.resetPreview"><i class="bx bx-x" aria-hidden="true"></i></button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto py-4">
        <p class="text-sm text-display">{{ changedCount }} 个文件将更新</p>
        <ul class="mt-4 border-y border-line">
          <li v-for="file in soul.preview.value?.files" :key="file.id" class="flex min-h-12 items-center gap-3 border-t border-line py-2 first:border-t-0">
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-sm font-normal text-display">{{ file.fileName }}</strong>
              <small class="block truncate font-mono text-[10px] text-disabled">{{ file.id }}</small>
            </span>
            <span class="text-xs" :class="file.change === 'replace' ? 'text-warning' : 'text-mute'">{{ file.change === "replace" ? "更新" : "不变" }}</span>
          </li>
        </ul>
        <p v-if="soul.error.value" class="mt-4 text-sm text-accent" role="alert">{{ soul.error.value }}</p>
      </div>

      <div data-slot="dialog-actions" class="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
        <button class="btn" type="button" :disabled="busy" @click="soul.resetPreview">取消</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="confirmImport">{{ soul.operation.value === "import" ? "导入中" : "确认导入" }}</button>
      </div>
    </section>
  </DialogOverlay>
</template>
