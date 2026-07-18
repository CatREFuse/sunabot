<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from "vue";
import type { SelfieReferenceImage } from "../../types";
import type { SelfieReferenceStatus, SelfieReferenceUpload } from "../../composables/useSelfieReferences";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";
import SelfieReferenceNoteDialog from "./SelfieReferenceNoteDialog.vue";

const props = defineProps<{
  open: boolean;
  images: readonly SelfieReferenceImage[];
  maxImages: number;
  loading: boolean;
  uploading: boolean;
  updatingId: string;
  deletingId: string;
  status: SelfieReferenceStatus;
}>();
const emit = defineEmits<{
  close: [];
  upload: [entries: readonly SelfieReferenceUpload[]];
  updateNote: [id: string, note: string];
  remove: [id: string];
}>();
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const previewImage = shallowRef<SelfieReferenceImage | null>(null);
const deleteImage = shallowRef<SelfieReferenceImage | null>(null);
const editImage = shallowRef<SelfieReferenceImage | null>(null);
const pendingFiles = shallowRef<readonly File[]>([]);
const selectionError = shallowRef("");
const noteSubmission = shallowRef<"upload" | "edit" | null>(null);
const noteRequestError = shallowRef("");
const remaining = computed(() => Math.max(0, props.maxImages - props.images.length));
const noteMode = computed<"upload" | "edit">(() => editImage.value ? "edit" : "upload");
const noteItems = computed(() => {
  if (editImage.value) {
    return [{ id: editImage.value.id, label: editImage.value.fileName, note: editImage.value.note }];
  }
  return pendingFiles.value.map((file, index) => ({ id: `upload-${index}`, label: file.name, note: "" }));
});
const noteDialogOpen = computed(() => Boolean(editImage.value) || pendingFiles.value.length > 0);
const noteSaving = computed(() => Boolean(noteSubmission.value)
  || (noteMode.value === "edit" ? Boolean(props.updatingId) : props.uploading));

watch(() => props.open, (open) => {
  if (open) return;
  previewImage.value = null;
  deleteImage.value = null;
  editImage.value = null;
  pendingFiles.value = [];
  selectionError.value = "";
  noteSubmission.value = null;
  noteRequestError.value = "";
});

watch(
  () => [props.uploading, props.updatingId, props.status.kind, props.status.message] as const,
  ([uploading, updatingId, statusKind, statusMessage]) => {
    const submission = noteSubmission.value;
    if (!submission) return;
    const busy = submission === "upload" ? uploading : Boolean(updatingId);
    if (busy || statusKind === "idle") return;
    noteSubmission.value = null;
    if (statusKind === "success") {
      editImage.value = null;
      pendingFiles.value = [];
      noteRequestError.value = "";
      return;
    }
    noteRequestError.value = statusMessage;
  }
);

function chooseImages() {
  fileInput.value?.click();
}

function selected(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  if (files.length > remaining.value) {
    selectionError.value = `还可添加 ${remaining.value} 张`;
    return;
  }
  selectionError.value = "";
  pendingFiles.value = files;
}

function closeNotes() {
  if (noteSaving.value) return;
  editImage.value = null;
  pendingFiles.value = [];
  noteSubmission.value = null;
  noteRequestError.value = "";
}

function saveNotes(items: Array<{ id: string; note: string }>) {
  noteRequestError.value = "";
  if (editImage.value) {
    const note = items[0]?.note;
    if (note) {
      noteSubmission.value = "edit";
      emit("updateNote", editImage.value.id, note);
    }
    return;
  }
  const noteById = new Map(items.map((item) => [item.id, item.note]));
  const entries = pendingFiles.value.map((file, index) => ({ file, note: noteById.get(`upload-${index}`) ?? "" }));
  if (entries.length) {
    noteSubmission.value = "upload";
    emit("upload", entries);
  }
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
          <h2 id="selfie-reference-title" class="text-xl font-medium text-display">自拍参考图</h2>
          <p class="mt-1 text-xs text-mute">素材库最多 {{ maxImages }} 张，每次自拍选用 1–3 张</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <div class="min-h-0 overflow-y-auto p-4 md:p-5">
        <div v-if="images.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <article v-for="image in images" :key="image.id" class="group min-w-0 overflow-hidden border-b border-line transition-colors focus-within:border-display">
            <div class="relative aspect-square overflow-hidden bg-raised">
              <button class="block h-full w-full" type="button" :aria-label="`查看原图 ${image.note}`" @click="previewImage = image">
                <AuthenticatedImage
                  :src="image.originalUrl"
                  :display-src="image.displayUrl"
                  :placeholder-src="image.placeholderUrl"
                  :alt="image.note"
                  thumbnail
                  class-name="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              </button>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-3">
              <span class="min-w-0">
                <strong class="block truncate text-sm font-medium text-display" :title="image.note">{{ image.note }}</strong>
                <span class="block truncate text-xs text-mute" :title="image.fileName">{{ image.fileName }}</span>
                <span class="block font-mono text-[10px] text-mute" :title="`${formatExactNumber(image.width)} × ${formatExactNumber(image.height)} px`">{{ formatDashboardMetric(image.width) }} × {{ formatDashboardMetric(image.height) }} · {{ formatBytes(image.sizeBytes) }}</span>
              </span>
              <span class="flex items-center gap-1">
                <button class="icon-btn" type="button" :aria-label="`编辑备注 ${image.note}`" :disabled="Boolean(updatingId)" @click="editImage = image"><i class="bx bx-edit" aria-hidden="true"></i></button>
                <button class="icon-btn text-accent" type="button" :aria-label="`删除 ${image.note}`" :disabled="deletingId === image.id" @click="deleteImage = image"><i class="bx bx-trash" aria-hidden="true"></i></button>
              </span>
            </div>
          </article>
        </div>
        <div v-else class="empty-state min-h-72">
          <div><i class="bx bx-camera mb-3 text-3xl text-mute" aria-hidden="true"></i><strong>{{ loading ? "加载中" : "还没有参考图" }}</strong><p>添加正面或半身图片</p></div>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 md:p-5">
        <span class="inline-state" :data-kind="selectionError ? 'error' : status.kind === 'idle' ? undefined : status.kind">{{ selectionError || status.message || `${images.length} / ${maxImages} 张素材` }}</span>
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
        <span class="min-w-0"><strong class="block truncate text-sm font-medium">{{ previewImage.note }}</strong><small class="block truncate text-xs text-white/60">{{ previewImage.fileName }}</small></span>
        <button class="icon-btn text-white hover:text-white" type="button" aria-label="关闭预览" @click="previewImage = null"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <div class="grid min-h-0 place-items-center overflow-auto p-3 md:p-6">
        <AuthenticatedImage :src="previewImage.originalUrl" :alt="previewImage.note" class-name="max-h-full max-w-full object-contain" placeholder-class-name="min-h-64 w-full" />
      </div>
    </div>
  </DialogOverlay>

  <DialogOverlay :open="Boolean(deleteImage)" :z-index="100" labelledby="selfie-delete-title" @close="deleteImage = null">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="selfie-delete-title" class="text-xl font-medium text-display">删除这张参考图？</h2>
      <p class="mt-3 truncate text-sm font-medium text-display">{{ deleteImage?.note }}</p>
      <p class="mt-1 truncate text-xs text-mute">{{ deleteImage?.fileName }}</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" @click="deleteImage = null">取消</button>
        <button class="btn btn-danger" type="button" :disabled="Boolean(deletingId)" @click="confirmRemove"><i class="bx bx-trash" aria-hidden="true"></i>删除</button>
      </div>
    </section>
  </DialogOverlay>

  <SelfieReferenceNoteDialog
    :open="noteDialogOpen"
    :items="noteItems"
    :mode="noteMode"
    :saving="noteSaving"
    :external-error="noteRequestError"
    @close="closeNotes"
    @save="saveNotes"
  />
</template>
