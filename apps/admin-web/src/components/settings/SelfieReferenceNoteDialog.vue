<script setup lang="ts">
import { ref, shallowRef, watch } from "vue";
import {
  MAX_SELFIE_REFERENCE_NOTE_LENGTH,
  normalizeSelfieReferenceNote
} from "../../composables/useSelfieReferences";
import DialogOverlay from "../ui/DialogOverlay.vue";

interface NoteItem {
  id: string;
  label: string;
  note: string;
}

const props = withDefaults(defineProps<{
  open: boolean;
  items: readonly NoteItem[];
  mode?: "upload" | "edit";
  saving?: boolean;
  externalError?: string;
}>(), {
  mode: "upload",
  saving: false,
  externalError: ""
});
const emit = defineEmits<{
  close: [];
  save: [items: Array<{ id: string; note: string }>];
}>();
const drafts = ref<NoteItem[]>([]);
const error = shallowRef("");

watch(
  () => [props.open, props.items] as const,
  ([open]) => {
    if (!open) return;
    drafts.value = props.items.map((item) => ({ ...item }));
    error.value = "";
  },
  { immediate: true }
);

function close() {
  if (!props.saving) emit("close");
}

function save() {
  const normalized: Array<{ id: string; note: string }> = [];
  for (const draft of drafts.value) {
    const note = normalizeSelfieReferenceNote(draft.note);
    if (!note) {
      error.value = draft.note.trim() ? "备注无效" : "请填写每张图片的备注";
      return;
    }
    normalized.push({ id: draft.id, note });
  }
  error.value = "";
  emit("save", normalized);
}
</script>

<template>
  <DialogOverlay :open="open" :z-index="110" labelledby="selfie-note-title" @close="close">
    <section class="grid max-h-[calc(100dvh-32px)] w-full max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded border border-visible bg-panel">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5">
        <h2 id="selfie-note-title" class="text-xl font-medium text-display">{{ mode === "edit" ? "编辑图片备注" : "填写图片备注" }}</h2>
        <button class="icon-btn" type="button" aria-label="关闭" :disabled="saving" @click="close"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>

      <form id="selfie-note-form" class="min-h-0 overflow-y-auto p-4 md:p-5" novalidate @submit.prevent="save">
        <div class="grid gap-4">
          <label v-for="draft in drafts" :key="draft.id" class="field">
            <span class="field-label flex items-center justify-between gap-3"><span class="truncate" :title="draft.label">{{ draft.label }}</span><small class="shrink-0 font-mono text-[10px] text-mute">最多 {{ MAX_SELFIE_REFERENCE_NOTE_LENGTH }} 个字</small></span>
            <input
              v-model="draft.note"
              class="control"
              type="text"
              placeholder="例如：泳装、女仆装"
              autocomplete="off"
              :aria-label="`${draft.label} 的备注`"
            >
          </label>
        </div>
      </form>

      <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 md:p-5">
        <span class="inline-state" :data-kind="error || externalError ? 'error' : undefined">{{ error || externalError }}</span>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost" type="button" :disabled="saving" @click="close">取消</button>
          <button class="btn btn-primary" type="submit" form="selfie-note-form" :disabled="saving || !drafts.length">
            <i class="bx" :class="saving ? 'bx-loader-alt bx-spin' : 'bx-check'" aria-hidden="true"></i>
            {{ saving ? "保存中" : mode === "edit" ? "保存" : "保存并上传" }}
          </button>
        </div>
      </footer>
    </section>
  </DialogOverlay>
</template>
