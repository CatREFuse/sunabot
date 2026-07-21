<script setup lang="ts">
import { shallowRef, watch } from "vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  upload: [input: { path: string; content: string }];
}>();
const documentPath = shallowRef("");
const content = shallowRef("");
const fileName = shallowRef("");
const localError = shallowRef("");

watch(() => props.open, (open) => {
  if (open) {
    documentPath.value = "";
    content.value = "";
    fileName.value = "";
    localError.value = "";
  }
});

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!/\.(?:md|markdown)$/iu.test(file.name)) {
    localError.value = "请选择 Markdown 文件";
    input.value = "";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    localError.value = "文件不能超过 8 MiB";
    input.value = "";
    return;
  }
  try {
    content.value = await file.text();
    fileName.value = file.name;
    if (!documentPath.value.trim()) documentPath.value = file.name;
    localError.value = "";
  } catch {
    localError.value = "文件读取失败";
  }
}

function submit() {
  const path = documentPath.value.trim();
  if (!fileName.value || !content.value.trim()) {
    localError.value = "请选择 Markdown 文件";
    return;
  }
  if (!path) {
    localError.value = "请输入保存位置";
    return;
  }
  if (!/\.(?:md|markdown)$/iu.test(path)) {
    localError.value = "保存位置需要使用 .md 或 .markdown";
    return;
  }
  emit("upload", { path, content: content.value });
}
</script>

<template>
  <DialogOverlay :open="open" aria-label="添加 Markdown" @close="emit('close')">
    <section class="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-visible bg-panel p-5 sm:p-7">
      <header class="flex items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <p class="meta-label">Knowledge</p>
          <h2 class="mt-2 text-2xl font-medium text-display">添加 Markdown</h2>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" :disabled="busy" @click="emit('close')">
          <i class="bx bx-x" aria-hidden="true"></i>
        </button>
      </header>

      <div class="grid gap-6 py-6">
        <label class="field">
          <span class="field-label">Markdown 文件</span>
          <input data-dialog-initial-focus class="control" type="file" accept=".md,.markdown,text/markdown" :disabled="busy" @change="selectFile">
        </label>
        <label class="field">
          <span class="field-label">保存位置</span>
          <input v-model="documentPath" class="control" type="text" placeholder="手册/开始.md" :disabled="busy">
        </label>
        <p v-if="localError || error" class="text-sm text-accent" role="alert">{{ localError || error }}</p>
      </div>

      <footer class="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="button" :disabled="busy || !fileName" @click="submit">
          <i class="bx bx-upload" aria-hidden="true"></i>{{ busy ? "添加中" : "添加" }}
        </button>
      </footer>
    </section>
  </DialogOverlay>
</template>
