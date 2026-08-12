<script setup lang="ts">
import type { EmojiVersionRecord } from "../../types/emojis";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{
  emojiKey: string;
  versions: readonly EmojiVersionRecord[];
  loading: boolean;
  deletingFileName: string;
}>();
const emit = defineEmits<{
  close: [];
  remove: [version: EmojiVersionRecord];
}>();

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
</script>

<template>
  <DialogOverlay :open="Boolean(emojiKey)" labelledby="emoji-versions-title" @close="emit('close')">
    <section class="flex max-h-[min(720px,calc(100dvh-32px))] w-full max-w-lg flex-col rounded border border-visible bg-panel">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4">
        <div class="min-w-0">
          <h2 id="emoji-versions-title" class="truncate text-lg font-medium text-display">{{ emojiKey }} · 版本</h2>
          <p class="mt-1 font-mono text-[10px] text-mute">{{ versions.length.toLocaleString("zh-CN") }} / 20</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <div v-if="loading" class="empty-state min-h-32"><div><i class="bx bx-loader-alt bx-spin text-2xl" aria-hidden="true"></i><strong class="mt-2 block">正在读取版本</strong></div></div>
        <div v-else-if="versions.length" class="grid gap-2">
          <article v-for="version in versions" :key="version.fileName" class="flex min-w-0 items-center gap-3 border-b border-line py-2">
            <div class="size-14 shrink-0 overflow-hidden">
              <AuthenticatedImage
                :src="version.originalUrl"
                :display-src="version.displayUrl"
                :placeholder-src="version.placeholderUrl"
                :alt="`${emojiKey}表情版本`"
                thumbnail
                class-name="h-full w-full object-cover"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <strong class="text-xs font-medium text-display">{{ version.current ? "当前版本" : formatTime(version.updatedAt) }}</strong>
                <span class="inline-state px-1.5 py-0.5 text-[9px]">{{ version.source === "generated" ? "一键生成" : "上传" }}</span>
              </div>
              <p class="mt-1 truncate font-mono text-[9px] text-disabled">{{ version.fileName }}</p>
            </div>
            <button v-if="!version.current" class="icon-btn size-8 shrink-0 text-accent" type="button" :disabled="Boolean(deletingFileName)" aria-label="删除旧版本" @click="emit('remove', version)"><i class="bx" :class="deletingFileName === version.fileName ? 'bx-loader-alt bx-spin' : 'bx-trash'" aria-hidden="true"></i></button>
          </article>
        </div>
        <div v-else class="empty-state min-h-32"><div><strong>没有可用版本</strong></div></div>
      </div>
    </section>
  </DialogOverlay>
</template>
