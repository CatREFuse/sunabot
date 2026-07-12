<script setup lang="ts">
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
  <section class="mt-8 border-t border-visible pt-8">
    <div class="flex items-end justify-between gap-4">
      <h2 class="section-title">生成历史</h2>
      <span class="font-mono text-[10px] text-mute">{{ images.length.toLocaleString("zh-CN") }} 张</span>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <article v-for="image in images" :key="image.id" class="group min-w-0 overflow-hidden border-b border-line pb-4">
        <div class="relative aspect-square overflow-hidden bg-raised">
          <button class="block h-full w-full" type="button" :aria-label="`预览 ${image.prompt || '历史图像'}`" @click="emit('preview', image)">
            <AuthenticatedImage :src="image.url" :alt="image.prompt || '历史图像'" thumbnail class-name="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-85" />
          </button>
        </div>
        <div class="grid gap-3 pt-4">
          <p class="line-clamp-2 min-h-10 text-xs leading-5 text-ink">{{ image.prompt || "无提示词" }}</p>
          <div class="flex min-w-0 items-center justify-between gap-3">
            <p class="min-w-0 font-mono text-[10px] leading-4 text-disabled"><span class="block">{{ image.size || "--" }}</span><span class="block">{{ formatFullDateTime(image.createdAt) }}</span></p>
            <div class="flex shrink-0 items-center gap-1">
              <button class="icon-btn" type="button" aria-label="预览图片" @click="emit('preview', image)"><i class="bx bx-show" aria-hidden="true"></i></button>
              <button class="icon-btn" type="button" :aria-label="`下载图片 ${image.id}`" :disabled="downloadingId === image.id" @click="emit('download', image)"><i class="bx bx-download" aria-hidden="true"></i></button>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-if="!images.length" class="empty-state">
      <div><strong>{{ loading ? "加载中" : "没有生成记录" }}</strong></div>
    </div>
  </section>
</template>
