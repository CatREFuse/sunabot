<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { EmojiRecord } from "../../types/emojis";
import { emojiKeyValidationError, normalizeEmojiKey } from "../../utils/emojiKey";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";

const props = defineProps<{
  emojiKey: string;
  emoji: EmojiRecord | null;
  preset: boolean;
  generating: boolean;
  uploading: boolean;
  deleting: boolean;
}>();
const emit = defineEmits<{
  generate: [key: string];
  edit: [key: string];
  upload: [key: string, file: File];
  rename: [key: string, nextKey: string];
  versions: [key: string];
  remove: [emoji: EmojiRecord];
}>();

const dragDepth = shallowRef(0);
const renaming = shallowRef(false);
const nextKey = shallowRef("");
const renameError = shallowRef("");
const dragging = computed(() => dragDepth.value > 0);
const busy = computed(() => props.generating || props.uploading || props.deleting);
const sourceLabel = computed(() => props.emoji?.source === "generated" ? "一键生成" : "上传");
const metadata = computed(() => {
  if (!props.emoji) return "待添加";
  return `${props.emoji.width.toLocaleString("zh-CN")} × ${props.emoji.height.toLocaleString("zh-CN")} · ${formatBytes(props.emoji.sizeBytes)}`;
});

watch(() => props.emojiKey, () => {
  renaming.value = false;
  nextKey.value = props.emojiKey;
  renameError.value = "";
});

function startRename() {
  nextKey.value = props.emojiKey;
  renameError.value = "";
  renaming.value = true;
}

function cancelRename() {
  renaming.value = false;
  renameError.value = "";
}

function saveRename() {
  const error = emojiKeyValidationError(nextKey.value);
  if (error) {
    renameError.value = error;
    return;
  }
  emit("rename", props.emojiKey, normalizeEmojiKey(nextKey.value));
  renaming.value = false;
}

function dragEnter(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth.value += 1;
}

function dragOver(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function dragLeave(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function drop(event: DragEvent) {
  event.preventDefault();
  dragDepth.value = 0;
  const file = event.dataTransfer?.files?.[0];
  if (file && !busy.value) emit("upload", props.emojiKey, file);
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("zh-CN")} KB`;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}
</script>

<template>
  <article class="group relative flex min-w-0 gap-3 border-b border-line py-3" @dragenter="dragEnter" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
    <button
      class="relative grid size-24 shrink-0 place-items-center overflow-hidden bg-raised text-mute transition-colors hover:bg-line disabled:cursor-wait"
      type="button"
      :disabled="busy"
      :aria-label="emoji ? `替换图片 ${emojiKey}` : `添加图片 ${emojiKey}`"
      @click="emit('edit', emojiKey)"
    >
      <AuthenticatedImage
        v-if="emoji"
        :src="emoji.originalUrl"
        :display-src="emoji.displayUrl"
        :placeholder-src="emoji.placeholderUrl"
        :alt="`${emojiKey}表情`"
        thumbnail
        class-name="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
      />
      <i v-else class="bx bx-image-add text-2xl" aria-hidden="true"></i>
      <span v-if="dragging" class="absolute inset-0 grid place-items-center bg-panel/90 text-xs font-medium text-display">松开上传</span>
      <span v-else-if="uploading" class="absolute inset-0 grid place-items-center bg-panel/80"><i class="bx bx-loader-alt bx-spin text-2xl" aria-hidden="true"></i></span>
    </button>

    <div class="flex min-w-0 flex-1 flex-col justify-between gap-2 py-0.5">
      <div class="min-w-0">
        <div v-if="renaming" class="flex min-w-0 items-center gap-1">
          <input v-model="nextKey" class="control h-8 min-w-0 flex-1 px-2 text-sm" type="text" maxlength="24" autocomplete="off" :aria-label="`修改 ${emojiKey} key`" @keyup.enter="saveRename" @keyup.esc="cancelRename">
          <button class="icon-btn size-8" type="button" aria-label="保存 key" @click="saveRename"><i class="bx bx-check" aria-hidden="true"></i></button>
          <button class="icon-btn size-8" type="button" aria-label="取消修改 key" @click="cancelRename"><i class="bx bx-x" aria-hidden="true"></i></button>
        </div>
        <div v-else class="flex min-w-0 items-center gap-2">
          <h3 class="min-w-0 truncate text-sm font-medium text-display">{{ emojiKey }}</h3>
          <span v-if="preset" class="inline-state shrink-0 px-1.5 py-0.5 text-[9px]">预设</span>
          <button v-if="emoji" class="icon-btn size-7 shrink-0" type="button" :disabled="busy" :aria-label="`修改 ${emojiKey} key`" @click="startRename"><i class="bx bx-pencil" aria-hidden="true"></i></button>
        </div>
        <p v-if="renameError" class="mt-1 text-[10px] text-accent">{{ renameError }}</p>
        <p v-else class="mt-1 truncate font-mono text-[10px] text-mute">[/{{ emojiKey }}]</p>
      </div>

      <div class="flex min-w-0 items-center justify-between gap-2">
        <p class="min-w-0 truncate font-mono text-[10px] text-disabled">{{ metadata }}<template v-if="emoji"> · {{ sourceLabel }}</template></p>
        <div class="flex shrink-0 items-center gap-1">
          <button class="icon-btn size-8" type="button" :disabled="busy" :aria-label="emoji ? `重新生成 ${emojiKey}` : `一键添加 ${emojiKey}`" @click="emit('generate', emojiKey)">
            <i class="bx" :class="generating ? 'bx-loader-alt bx-spin' : emoji ? 'bx-refresh' : 'bx-magic-wand'" aria-hidden="true"></i>
          </button>
          <button class="icon-btn size-8" type="button" :disabled="busy" :aria-label="emoji ? `替换 ${emojiKey}` : `上传 ${emojiKey}`" @click="emit('edit', emojiKey)"><i class="bx bx-upload" aria-hidden="true"></i></button>
          <button v-if="emoji" class="icon-btn size-8" type="button" :disabled="busy" :aria-label="`查看 ${emojiKey} 版本`" @click="emit('versions', emojiKey)"><i class="bx bx-history" aria-hidden="true"></i></button>
          <button v-if="emoji" class="icon-btn size-8 text-accent" type="button" :disabled="busy" :aria-label="`删除 ${emojiKey}`" @click="emit('remove', emoji)"><i class="bx bx-trash" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>
  </article>
</template>
