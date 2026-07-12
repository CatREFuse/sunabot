<script setup lang="ts">
import { formatFullDateTime } from "../../utils/format";
import type { ImageHistoryRecord } from "../../types";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{ image: ImageHistoryRecord | null; downloading: boolean }>();
const emit = defineEmits<{ close: []; download: [image: ImageHistoryRecord] }>();
</script>

<template>
  <DialogOverlay :open="Boolean(image)" placement="full" backdrop="preview" :z-index="80" aria-label="图片预览" @close="emit('close')">
    <div v-if="image" class="mx-auto grid h-full min-h-0 w-full max-w-7xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded border border-white/20 bg-black text-white">
      <header class="flex items-center justify-between gap-4 border-b border-white/15 px-4 py-3">
        <div class="min-w-0"><p class="font-mono text-[10px] tracking-[0.08em] text-white/55">PREVIEW</p><p class="truncate text-sm">{{ image.prompt || "无提示词" }}</p></div>
        <button class="icon-btn text-white hover:text-white" type="button" aria-label="关闭预览" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>
      <div class="grid min-h-0 place-items-center overflow-auto p-3 md:p-6">
        <AuthenticatedImage :src="image.url" :alt="image.prompt || '历史图像预览'" class-name="max-h-full max-w-full object-contain" placeholder-class-name="min-h-64 w-full" />
      </div>
      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-white/15 px-4 py-3">
        <p class="font-mono text-[10px] text-white/55">{{ image.size || "--" }} · {{ formatFullDateTime(image.createdAt) }}</p>
        <div class="flex gap-2">
          <button class="btn border-white bg-white text-black hover:border-white hover:bg-white/85 hover:text-black" type="button" :disabled="downloading" @click="emit('download', image)"><i class="bx bx-download" aria-hidden="true"></i>{{ downloading ? "下载中" : "下载" }}</button>
        </div>
      </footer>
    </div>
  </DialogOverlay>
</template>
