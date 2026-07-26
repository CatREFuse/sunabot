<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from "vue";
import type { EmojiUploadInput } from "../../types/emojis";
import { emojiKeyValidationError, normalizeEmojiKey } from "../../utils/emojiKey";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  emojiKey: string;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  save: [input: EmojiUploadInput];
}>();
const keyInput = shallowRef("");
const file = shallowRef<File | null>(null);
const localError = shallowRef("");
const dragging = shallowRef(false);
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const fixedKey = computed(() => Boolean(props.emojiKey));
const title = computed(() => fixedKey.value ? `替换“${props.emojiKey}”` : "新增表情");
const marker = computed(() => keyInput.value.trim() ? `[/${keyInput.value.trim()}]` : "[/表情名称]");

watch(
  [() => props.open, () => props.emojiKey],
  () => {
    if (!props.open) return;
    keyInput.value = props.emojiKey;
    file.value = null;
    localError.value = "";
    if (fileInput.value) fileInput.value.value = "";
  },
  { immediate: true, flush: "post" }
);

function chooseFile() {
  fileInput.value?.click();
}

function selected(event: Event) {
  const input = event.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
  localError.value = "";
}

function dragOver(event: DragEvent) {
  if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
  event.preventDefault();
  dragging.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function dragLeave() {
  dragging.value = false;
}

function drop(event: DragEvent) {
  event.preventDefault();
  dragging.value = false;
  file.value = event.dataTransfer?.files?.[0] ?? null;
  localError.value = "";
}

function save() {
  const keyError = emojiKeyValidationError(keyInput.value);
  if (keyError) {
    localError.value = keyError;
    return;
  }
  if (!file.value) {
    localError.value = "请选择图片";
    return;
  }
  const key = normalizeEmojiKey(keyInput.value);
  emit("save", { key, file: file.value });
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("zh-CN")} KB`;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}
</script>

<template>
  <DialogOverlay :open="open" class="!p-0 sm:!p-4" labelledby="emoji-editor-title" @close="emit('close')">
    <form class="flex h-full max-h-full w-full max-w-xl flex-col border-visible bg-panel sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:rounded sm:border" @submit.prevent="save">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5">
        <h2 id="emoji-editor-title" class="min-w-0 truncate text-xl font-medium text-display">{{ title }}</h2>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <div class="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4 md:p-5">
        <label class="field">
          <span class="field-label">名称</span>
          <input v-model="keyInput" class="control" type="text" maxlength="24" autocomplete="off" :disabled="fixedKey" :data-dialog-initial-focus="fixedKey ? undefined : ''">
        </label>
        <div class="flex min-w-0 items-center justify-between gap-4 border-y border-line py-3">
          <span class="meta-label">发送标记</span>
          <code class="min-w-0 truncate font-mono text-xs text-display">{{ marker }}</code>
        </div>
        <div class="field">
          <span class="field-label">图片</span>
          <button class="grid min-h-32 place-items-center border border-dashed bg-raised px-5 py-6 text-center transition-colors hover:border-display" :class="dragging ? 'border-display' : 'border-visible'" type="button" :data-dialog-initial-focus="fixedKey ? '' : undefined" @click="chooseFile" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
            <span v-if="file" class="min-w-0">
              <i class="bx bx-image text-3xl text-mute" aria-hidden="true"></i>
              <strong class="mt-3 block max-w-full truncate text-sm font-medium text-display">{{ file.name }}</strong>
              <span class="mt-1 block font-mono text-[10px] text-mute">{{ formatBytes(file.size) }}</span>
            </span>
            <span v-else>
              <i class="bx bx-upload text-3xl text-mute" aria-hidden="true"></i>
              <strong class="mt-3 block text-sm font-medium text-display">拖入或选择图片</strong>
              <span class="mt-1 block text-xs text-mute">PNG、JPEG、WebP、GIF</span>
            </span>
          </button>
          <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="selected">
        </div>
        <p v-if="localError || error" class="inline-state" data-kind="error">{{ localError || error }}</p>
      </div>

      <footer class="flex justify-end gap-2 border-t border-line p-4 md:p-5">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy"><i class="bx" :class="busy ? 'bx-loader-alt bx-spin' : 'bx-check'" aria-hidden="true"></i>{{ busy ? "保存中" : "保存" }}</button>
      </footer>
    </form>
  </DialogOverlay>
</template>
