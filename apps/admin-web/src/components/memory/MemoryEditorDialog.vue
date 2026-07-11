<script setup lang="ts">
import { X } from "lucide-vue-next";
import { computed, reactive, watch } from "vue";
import type { MemoryEntry, MemorySource, MemorySourceId, MemoryWritePayload } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{ open: boolean; entry: MemoryEntry | null; sources: readonly MemorySource[]; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; save: [payload: MemoryWritePayload] }>();
const form = reactive({
  source: "working" as MemorySourceId,
  text: "",
  userId: "",
  addressName: ""
});
const editableSources = computed(() => props.sources.filter((item) => item.editable));
const userProfile = computed(() => form.source === "user_profile");

watch(
  [() => props.open, () => props.entry],
  () => {
    if (!props.open) return;
    form.source = props.entry?.source ?? editableSources.value[0]?.id ?? "working";
    form.text = props.entry?.text ?? "";
    form.userId = props.entry?.userId ?? "";
    form.addressName = props.entry?.addressName ?? "";
  },
  { immediate: true }
);

function save() {
  const payload: MemoryWritePayload = {
    source: form.source,
    id: props.entry?.id,
    text: form.text.trim()
  };
  if (userProfile.value) {
    payload.userId = form.userId.trim() || undefined;
    payload.addressName = form.addressName.trim() || undefined;
  }
  emit("save", payload);
}
</script>

<template>
  <DialogOverlay :open="open" class="!p-0 sm:!p-4" labelledby="memory-editor-title" @close="emit('close')">
    <form class="flex h-full max-h-full w-full max-w-2xl flex-col border-visible bg-panel sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:rounded-2xl sm:border" @submit.prevent="save">
      <header class="flex items-center justify-between border-b border-line p-4 md:p-5">
        <div><p class="page-kicker">MEMORY ENTRY</p><h2 id="memory-editor-title" class="mt-1 text-xl font-medium text-display">{{ entry ? "编辑记忆" : "新增记忆" }}</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><X :size="19" :stroke-width="1.5" /></button>
      </header>
      <div class="grid min-h-0 flex-1 gap-5 overflow-y-auto p-4 md:p-5">
        <label class="field">
          <span class="field-label">来源</span>
          <select v-model="form.source" class="control" :disabled="Boolean(entry)">
            <option v-for="source in editableSources" :key="source.id" :value="source.id">{{ source.title }}</option>
          </select>
        </label>
        <div v-if="userProfile" class="grid gap-5 sm:grid-cols-2">
          <label class="field">
            <span class="field-label">QQ</span>
            <input v-model="form.userId" class="control" type="text" inputmode="numeric" :disabled="Boolean(entry)" required>
          </label>
          <label class="field">
            <span class="field-label">称呼</span>
            <input v-model="form.addressName" class="control" type="text" autocomplete="off">
          </label>
        </div>
        <label class="field">
          <span class="field-label">正文</span>
          <textarea v-model="form.text" class="control min-h-56" required maxlength="262144"></textarea>
        </label>
        <p v-if="error" class="inline-state" data-kind="error">[ERROR: {{ error }}]</p>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line p-4 md:p-5">
        <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy || !form.text.trim()">{{ busy ? "保存中" : "保存" }}</button>
      </footer>
    </form>
  </DialogOverlay>
</template>
