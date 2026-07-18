<script setup lang="ts">
import { computed } from "vue";
import type { EmojiRecord } from "../../types/emojis";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";

const props = defineProps<{
  emojiKey: string;
  emoji: EmojiRecord | null;
  preset: boolean;
  generating: boolean;
  deleting: boolean;
}>();
const emit = defineEmits<{
  generate: [key: string];
  edit: [key: string];
  remove: [emoji: EmojiRecord];
}>();

const sourceLabel = computed(() => props.emoji?.source === "generated" ? "一键生成" : "上传");
const metadata = computed(() => {
  if (!props.emoji) return "待添加";
  return `${props.emoji.width.toLocaleString("zh-CN")} × ${props.emoji.height.toLocaleString("zh-CN")} · ${formatBytes(props.emoji.sizeBytes)}`;
});

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("zh-CN")} KB`;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}
</script>

<template>
  <article class="group min-w-0 overflow-hidden border-b border-line pb-4">
    <div class="relative aspect-square overflow-hidden bg-raised">
      <AuthenticatedImage
        v-if="emoji"
        :src="emoji.originalUrl"
        :display-src="emoji.displayUrl"
        :placeholder-src="emoji.placeholderUrl"
        :alt="`${emojiKey}表情`"
        thumbnail
        class-name="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
      />
      <div v-else class="grid h-full place-items-center text-center text-mute">
        <div>
          <i class="bx bx-image-add text-3xl" aria-hidden="true"></i>
          <strong class="mt-3 block text-sm font-medium text-display">{{ emojiKey }}</strong>
        </div>
      </div>
      <span v-if="preset" class="absolute left-3 top-3 bg-panel/90 px-2 py-1 font-mono text-[10px] text-ink backdrop-blur">预设</span>
    </div>

    <div class="grid gap-3 pt-4">
      <div class="flex min-w-0 items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="truncate text-base font-medium text-display">{{ emojiKey }}</h3>
          <p class="mt-1 truncate font-mono text-[10px] text-mute">[/{{ emojiKey }}]</p>
        </div>
        <span v-if="emoji" class="inline-state shrink-0">{{ sourceLabel }}</span>
      </div>
      <p class="font-mono text-[10px] text-disabled">{{ metadata }}</p>

      <div v-if="emoji" class="flex flex-wrap items-center gap-2">
        <button class="btn btn-ghost min-w-0 flex-1" type="button" :disabled="generating || deleting" @click="emit('generate', emojiKey)">
          <i class="bx" :class="generating ? 'bx-loader-alt bx-spin' : 'bx-refresh'" aria-hidden="true"></i>{{ generating ? "生成中" : "重新生成" }}
        </button>
        <button class="icon-btn" type="button" :disabled="generating || deleting" :aria-label="`替换 ${emojiKey}`" @click="emit('edit', emojiKey)"><i class="bx bx-upload" aria-hidden="true"></i></button>
        <button class="icon-btn text-accent" type="button" :disabled="generating || deleting" :aria-label="`删除 ${emojiKey}`" @click="emit('remove', emoji)"><i class="bx bx-trash" aria-hidden="true"></i></button>
      </div>
      <div v-else class="grid grid-cols-2 gap-2">
        <button class="btn btn-primary" type="button" :disabled="generating" @click="emit('generate', emojiKey)">
          <i class="bx" :class="generating ? 'bx-loader-alt bx-spin' : 'bx-magic-wand'" aria-hidden="true"></i>{{ generating ? "生成中" : "一键添加" }}
        </button>
        <button class="btn btn-ghost" type="button" :disabled="generating" @click="emit('edit', emojiKey)"><i class="bx bx-upload" aria-hidden="true"></i>上传</button>
      </div>
    </div>
  </article>
</template>
