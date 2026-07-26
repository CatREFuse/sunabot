<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { MemoryEntry, MemorySourceId, MemoryWritePayload } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

type EditableMemorySourceId = Exclude<MemorySourceId, "working">;

const props = defineProps<{
  open: boolean;
  entry: MemoryEntry | null;
  source: EditableMemorySourceId;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; save: [payload: MemoryWritePayload] }>();
const form = reactive({
  source: "long_term" as EditableMemorySourceId,
  text: "",
  userId: "",
  addressNames: ""
});
const userProfile = computed(() => form.source === "user_profile");
const sourceTitle = computed(() => userProfile.value ? "用户画像" : "长期记忆");

watch(
  [() => props.open, () => props.entry, () => props.source],
  () => {
    if (!props.open) return;
    form.source = props.entry?.source === "user_profile" ? "user_profile" : props.source;
    form.text = props.entry?.text ?? "";
    form.userId = props.entry?.userId ?? "";
    form.addressNames = (props.entry?.addressNames ?? (props.entry?.addressName ? [props.entry.addressName] : [])).join("、");
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
    if (!props.entry) payload.userId = form.userId.trim() || undefined;
    payload.addressNames = [...new Set(form.addressNames
      .split(/[\n,，、]+/u)
      .map((name) => name.trim())
      .filter(Boolean))];
  }
  emit("save", payload);
}
</script>

<template>
  <DialogOverlay :open="open" class="!p-0 sm:!p-4" labelledby="memory-editor-title" @close="emit('close')">
    <form class="flex h-full max-h-full w-full max-w-2xl flex-col border-visible bg-panel sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:rounded sm:border" @submit.prevent="save">
      <header class="flex items-start justify-between gap-6 border-b border-line p-5 md:p-6">
        <div>
          <p class="field-label">{{ sourceTitle }}</p>
          <h2 id="memory-editor-title" class="mt-2 text-2xl font-medium tracking-[-0.02em] text-display">
            {{ entry ? "编辑记忆" : `新增${sourceTitle}` }}
          </h2>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>
      <div class="grid min-h-0 flex-1 gap-6 overflow-y-auto p-5 md:p-6">
        <div v-if="userProfile" class="grid gap-5 sm:grid-cols-2">
          <label class="field">
            <span class="field-label">QQ 号</span>
            <input v-model="form.userId" class="control" type="text" inputmode="numeric" :disabled="Boolean(entry)" required :data-dialog-initial-focus="entry ? undefined : ''">
          </label>
          <label class="field">
            <span class="field-label">称呼</span>
            <input v-model="form.addressNames" class="control" type="text" autocomplete="off" placeholder="多个称呼用顿号分隔">
          </label>
        </div>
        <label class="field">
          <span class="field-label">正文</span>
          <textarea v-model="form.text" class="control min-h-64" required maxlength="262144" :data-dialog-initial-focus="userProfile ? undefined : ''"></textarea>
        </label>
        <p v-if="error" class="inline-state" data-kind="error">{{ error }}</p>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line p-5 md:p-6">
        <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy || !form.text.trim()">{{ busy ? "保存中" : entry ? "保存更改" : "新增记忆" }}</button>
      </footer>
    </form>
  </DialogOverlay>
</template>
