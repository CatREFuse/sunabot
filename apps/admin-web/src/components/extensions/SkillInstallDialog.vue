<script setup lang="ts">
import { shallowRef, watch } from "vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{ open: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; submit: [input: { archive: File; replace: boolean }] }>();
const archive = shallowRef<File | null>(null);
const replace = shallowRef(false);

watch(() => props.open, (open) => {
  if (!open) {
    archive.value = null;
    replace.value = false;
  }
});

function choose(event: Event) {
  archive.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function submit() {
  if (archive.value) emit("submit", { archive: archive.value, replace: replace.value });
}
</script>

<template>
  <DialogOverlay :open="open" labelledby="skill-install-title" @close="emit('close')">
    <form class="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded border border-visible bg-panel" @submit.prevent="submit">
      <header class="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-5 md:px-8 md:py-6">
        <div><p class="meta-label">ZIP Package</p><h2 id="skill-install-title" class="mt-2 text-2xl font-medium text-display">安装 Skill</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <div data-slot="dialog-scroll" class="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">
        <label class="field">
          <span class="field-label">Skill ZIP</span>
          <input class="control file:mr-4 file:border-0 file:bg-transparent file:font-mono file:text-xs file:uppercase file:text-ink" type="file" accept=".zip,application/zip" required data-dialog-initial-focus @change="choose">
          <small class="text-xs text-mute">最大 16 MiB，安装后需独立审核才能启用</small>
        </label>
        <label class="mt-5 flex min-h-11 items-center gap-3 text-sm text-ink">
          <input v-model="replace" class="size-4 accent-current" type="checkbox">
          <span>替换同名 Skill</span>
        </label>
      </div>
      <footer data-slot="dialog-actions" class="shrink-0 border-t border-line px-5 py-4 md:px-8">
        <p v-if="error" class="mb-3 text-sm text-accent" role="alert">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-2"><button class="btn" type="button" @click="emit('close')">取消</button><button class="btn btn-primary" type="submit" :disabled="busy || !archive">{{ busy ? "安装中" : "安装" }}</button></div>
      </footer>
    </form>
  </DialogOverlay>
</template>
