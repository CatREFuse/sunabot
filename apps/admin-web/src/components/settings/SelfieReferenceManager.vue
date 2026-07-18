<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from "vue";
import type { SelfieReferenceImage } from "../../types";
import type { SelfieReferenceStatus, SelfieReferenceUpload } from "../../composables/useSelfieReferences";
import { formatDashboardMetric, formatExactNumber } from "../../utils/numberFormat";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";
import SelfieReferenceNoteDialog from "./SelfieReferenceNoteDialog.vue";

const props = defineProps<{
  images: readonly SelfieReferenceImage[];
  maxImages: number;
  loading: boolean;
  uploading: boolean;
  updatingId: string;
  deletingId: string;
  status: SelfieReferenceStatus;
}>();
const emit = defineEmits<{
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
const visibleStatus = computed(() => selectionError.value || props.status.message);
const visibleStatusKind = computed(() => selectionError.value
  ? "error"
  : props.status.kind === "idle" ? undefined : props.status.kind);

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
  <section class="border-t border-visible pt-8" aria-labelledby="selfie-reference-title">
    <header class="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-end">
      <div class="min-w-0">
        <h2 id="selfie-reference-title" class="section-title">自拍参考图</h2>
        <p class="mt-1 text-xs text-mute">素材库最多 {{ maxImages }} 张，每次自拍选用 1–3 张</p>
      </div>
      <div class="flex items-center justify-between gap-3 sm:justify-end">
        <span class="inline-state shrink-0" :data-kind="images.length === maxImages ? 'success' : undefined">
          <i class="bx" :class="images.length === maxImages ? 'bx-check-circle' : 'bx-images'" aria-hidden="true"></i>
          {{ loading ? "读取中" : `${images.length} / ${maxImages} 张` }}
        </span>
        <button class="btn btn-primary shrink-0" type="button" :disabled="uploading || loading || remaining === 0" @click="chooseImages">
          <i class="bx" :class="uploading ? 'bx-loader-alt bx-spin' : 'bx-plus'" aria-hidden="true"></i>
          {{ uploading ? "上传中" : remaining === 0 ? "已达上限" : "添加图片" }}
        </button>
        <input ref="fileInput" class="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="选择自拍参考图" @change="selected">
      </div>
    </header>

    <p v-if="visibleStatus" class="mt-4 inline-state" :data-kind="visibleStatusKind" aria-live="polite">{{ visibleStatus }}</p>

    <div v-if="images.length" class="mt-5 grid grid-cols-3 gap-x-2 gap-y-5 sm:grid-cols-6 sm:gap-x-3 lg:grid-cols-9">
      <article v-for="image in images" :key="image.id" class="group min-w-0 border-b border-line pb-3 transition-colors focus-within:border-display">
        <button class="block aspect-square w-full overflow-hidden bg-raised" type="button" :aria-label="`查看原图 ${image.note}`" @click="previewImage = image">
          <AuthenticatedImage
            :src="image.originalUrl"
            :display-src="image.displayUrl"
            :placeholder-src="image.placeholderUrl"
            :alt="image.note"
            thumbnail
            class-name="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        </button>
        <div class="mt-3 min-w-0">
          <strong class="block truncate text-sm font-medium text-display" :title="image.note">{{ image.note }}</strong>
          <span class="mt-1 block truncate text-[11px] text-mute" :title="image.fileName">{{ image.fileName }}</span>
          <span class="mt-1 block truncate font-mono text-[10px] text-mute" :title="`${formatExactNumber(image.width)} × ${formatExactNumber(image.height)} px · ${formatBytes(image.sizeBytes)}`">
            {{ formatDashboardMetric(image.width) }} × {{ formatDashboardMetric(image.height) }} · {{ formatBytes(image.sizeBytes) }}
          </span>
        </div>
        <div class="-ml-2 mt-1 flex items-center">
          <button class="icon-btn" type="button" :aria-label="`编辑备注 ${image.note}`" :disabled="Boolean(updatingId)" @click="editImage = image"><i class="bx bx-edit" aria-hidden="true"></i></button>
          <button class="icon-btn text-accent" type="button" :aria-label="`删除 ${image.note}`" :disabled="deletingId === image.id" @click="deleteImage = image"><i class="bx bx-trash" aria-hidden="true"></i></button>
        </div>
      </article>
    </div>

    <div v-else class="empty-state mt-5 min-h-48 border-y border-line py-16">
      <div><i class="bx bx-camera mb-3 text-3xl text-mute" aria-hidden="true"></i><strong>{{ loading ? "加载中" : "还没有参考图" }}</strong><p>添加 PNG、JPEG 或 WebP 图片</p></div>
    </div>
  </section>

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
