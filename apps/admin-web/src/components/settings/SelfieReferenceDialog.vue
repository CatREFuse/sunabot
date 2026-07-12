<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from "vue";
import type { SelfieReferenceImage } from "../../types";
import type { SelfieReferenceStatus } from "../../composables/useSelfieReferences";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  images: readonly SelfieReferenceImage[];
  maxImages: number;
  loading: boolean;
  uploading: boolean;
  deletingId: string;
  status: SelfieReferenceStatus;
}>();
const emit = defineEmits<{
  close: [];
  upload: [files: readonly File[]];
  remove: [id: string];
}>();
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const previewImage = shallowRef<SelfieReferenceImage | null>(null);
const deleteImage = shallowRef<SelfieReferenceImage | null>(null);
const remaining = computed(() => Math.max(0, props.maxImages - props.images.length));

watch(() => props.open, (open) => {
  if (open) return;
  previewImage.value = null;
  deleteImage.value = null;
});

function chooseImages() {
  fileInput.value?.click();
}

function selected(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length) emit("upload", files);
}

function confirmRemove() {
  if (!deleteImage.value) return;
  emit("remove", deleteImage.value.id);
  deleteImage.value = null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${formatExactNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}
</script>

<template>
  <DialogOverlay :open="open" class="!p-0 sm:!p-4" labelledby="selfie-reference-title" @close="emit('close')">
    <section class="grid h-full max-h-full w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-visible bg-panel sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:rounded sm:border">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5">
        <div class="min-w-0">
          <p class="page-kicker">SELFIE REFERENCES</p>
          <h2 id="selfie-reference-title" class="mt-1 text-xl font-medium text-display">自拍参考图</h2>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <div class="min-h-0 overflow-y-auto p-4 md:p-5">
        <div v-if="images.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <article v-for="image in images" :key="image.id" class="group min-w-0 overflow-hidden border-b border-line bg-page transition-colors focus-within:border-display">
            <div class="relative aspect-square overflow-hidden bg-raised">
              <button class="block h-full w-full" type="button" :aria-label="`查看原图 ${image.fileName}`" @click="previewImage = image">
                <AuthenticatedImage
                  :src="image.originalUrl"
                  :display-src="image.displayUrl"
                  :placeholder-src="image.placeholderUrl"
                  :alt="image.fileName"
                  thumbnail
                  class-name="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              </button>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-3">
              <span class="min-w-0">
                <strong class="block truncate text-sm font-medium text-display">{{ image.fileName }}</strong>
                <span class="block font-mono text-[10px] text-mute" :title="`${formatExactNumber(image.width)} × ${formatExactNumber(image.height)} px`">{{ formatDashboardMetric(image.width) }} × {{ formatDashboardMetric(image.height) }} · {{ formatBytes(image.sizeBytes) }}</span>
              </span>
              <button class="icon-btn text-accent" type="button" :aria-label="`删除 ${image.fileName}`" :disabled="deletingId === image.id" @click="deleteImage = image"><i class="bx bx-trash" aria-hidden="true"></i></button>
            </div>
          </article>
        </div>
        <div v-else class="empty-state min-h-72">
          <div><i class="bx bx-camera mb-3 text-3xl text-mute" aria-hidden="true"></i><strong>{{ loading ? "[LOADING...]" : "还没有参考图" }}</strong><p>添加普拉娜的正面或半身图片</p></div>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 md:p-5">
        <span class="inline-state" :data-kind="status.kind === 'idle' ? undefined : status.kind">{{ status.message || `${images.length} / ${maxImages} 张` }}</span>
        <div class="flex flex-wrap justify-end gap-2">
          <button class="btn btn-ghost" type="button" @click="emit('close')">完成</button>
          <button class="btn btn-primary" type="button" :disabled="uploading || loading || remaining === 0" @click="chooseImages"><i class="bx bx-upload" aria-hidden="true"></i>{{ uploading ? "上传中" : remaining === 0 ? "已达上限" : "添加图片" }}</button>
          <input ref="fileInput" class="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp" @change="selected">
        </div>
      </footer>
    </section>
  </DialogOverlay>

  <DialogOverlay :open="Boolean(previewImage)" placement="full" backdrop="preview" :z-index="90" aria-label="自拍参考图预览" @close="previewImage = null">
    <div v-if="previewImage" class="mx-auto grid h-full min-h-0 w-full max-w-7xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-black text-white">
      <header class="flex items-center justify-between gap-4 border-b border-white/15 px-4 py-3">
        <p class="min-w-0 truncate text-sm">{{ previewImage.fileName }}</p>
        <button class="icon-btn text-white hover:text-white" type="button" aria-label="关闭预览" @click="previewImage = null"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <div class="grid min-h-0 place-items-center overflow-auto p-3 md:p-6">
        <AuthenticatedImage :src="previewImage.originalUrl" :alt="previewImage.fileName" class-name="max-h-full max-w-full object-contain" placeholder-class-name="min-h-64 w-full" />
      </div>
    </div>
  </DialogOverlay>

  <DialogOverlay :open="Boolean(deleteImage)" :z-index="100" labelledby="selfie-delete-title" @close="deleteImage = null">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <p class="page-kicker">REMOVE IMAGE</p>
      <h2 id="selfie-delete-title" class="mt-2 text-xl font-medium text-display">删除这张参考图？</h2>
      <p class="mt-3 truncate text-sm text-mute">{{ deleteImage?.fileName }}</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" @click="deleteImage = null">取消</button>
        <button class="btn btn-danger" type="button" :disabled="Boolean(deletingId)" @click="confirmRemove"><i class="bx bx-trash" aria-hidden="true"></i>删除</button>
      </div>
    </section>
  </DialogOverlay>
</template>
