<script setup lang="ts">
import { Download, Eye } from "lucide-vue-next";
import { formatFullDateTime } from "../../utils/format";
import type { ImageHistoryRecord } from "../../types";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";

defineProps<{
  images: readonly ImageHistoryRecord[];
  loading: boolean;
  downloadingId: string;
}>();
const emit = defineEmits<{
  preview: [image: ImageHistoryRecord];
  download: [image: ImageHistoryRecord];
}>();
</script>

<template>
  <section class="mt-16 border-t border-visible pt-8">
    <div class="flex items-end justify-between gap-4">
      <div><p class="page-kicker">HISTORY</p><h2 class="section-title mt-2">生成历史</h2></div>
      <span class="font-mono text-[10px] text-mute">{{ images.length }} ITEMS</span>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <article v-for="image in images" :key="image.id" class="group min-w-0 overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-visible focus-within:border-display">
        <div class="relative aspect-square overflow-hidden bg-raised">
          <button class="block h-full w-full" type="button" :aria-label="`预览 ${image.prompt || '历史图像'}`" @click="emit('preview', image)">
            <AuthenticatedImage :src="image.url" :alt="image.prompt || '历史图像'" class-name="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02] group-hover:opacity-85" />
          </button>
          <div class="absolute inset-x-3 bottom-3 flex justify-end gap-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <button class="icon-btn size-11 border-white/40 bg-black/75 text-white hover:border-white hover:text-white" type="button" aria-label="预览图片" @click="emit('preview', image)"><Eye :size="17" :stroke-width="1.5" /></button>
            <button class="icon-btn size-11 border-white/40 bg-black/75 text-white hover:border-white hover:text-white" type="button" :aria-label="`下载图片 ${image.id}`" :disabled="downloadingId === image.id" @click="emit('download', image)"><Download :size="17" :stroke-width="1.5" /></button>
          </div>
        </div>
        <div class="grid gap-3 p-3">
          <p class="line-clamp-2 min-h-10 text-xs leading-5 text-ink">{{ image.prompt || "无提示词" }}</p>
          <p class="truncate font-mono text-[10px] text-disabled">{{ image.size || "--" }} · {{ formatFullDateTime(image.createdAt) }}</p>
        </div>
      </article>
    </div>

    <div v-if="!images.length" class="empty-state">
      <div><strong>{{ loading ? "[LOADING...]" : "没有生成记录" }}</strong><p>生成后保留在历史记录</p></div>
    </div>
  </section>
</template>
