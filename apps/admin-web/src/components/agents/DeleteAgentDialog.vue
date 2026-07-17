<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { AgentSummary } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{ open: boolean; agent?: AgentSummary; busy?: boolean; error?: string }>();
const emit = defineEmits<{ close: []; confirm: [confirmation: string] }>();
const confirmation = shallowRef("");
const confirmed = computed(() => confirmation.value === "确认删除");

watch(() => props.open, (open) => {
  if (!open) confirmation.value = "";
});

function submit() {
  if (!confirmed.value || props.busy) return;
  emit("confirm", confirmation.value);
}
</script>

<template>
  <DialogOverlay :open="open" labelledby="delete-agent-title" :dismissible="!busy" @close="emit('close')">
    <form class="w-full max-w-lg border border-visible bg-panel p-6 md:p-8" @submit.prevent="submit">
      <div class="flex items-center justify-between gap-4">
        <h2 id="delete-agent-title" class="text-2xl font-medium text-display">删除 Bot</h2>
        <button class="icon-btn" type="button" aria-label="关闭" :disabled="busy" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </div>
      <p class="mt-6 text-sm leading-6 text-ink">将删除 {{ agent?.name }} 及其数据，且无法恢复。</p>
      <label class="field mt-6">
        <span class="field-label">输入「确认删除」以继续</span>
        <input v-model="confirmation" class="control" autocomplete="off" :disabled="busy" data-dialog-initial-focus>
      </label>
      <p v-if="error" class="mt-5 text-sm text-accent" role="alert">{{ error }}</p>
      <div class="mt-8 flex justify-end gap-3">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-danger" type="submit" :disabled="busy || !confirmed">{{ busy ? "删除中" : "删除 Bot" }}</button>
      </div>
    </form>
  </DialogOverlay>
</template>
