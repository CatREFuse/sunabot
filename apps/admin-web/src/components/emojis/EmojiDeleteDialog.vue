<script setup lang="ts">
import type { EmojiRecord } from "../../types/emojis";
import { workbenchLabel } from "../../types/workbench";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{
  emoji: EmojiRecord | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<template>
  <DialogOverlay :open="Boolean(emoji)" labelledby="emoji-delete-title" :dismissible="!busy" @close="emit('close')">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="emoji-delete-title" class="text-xl font-medium text-display">删除“{{ emoji?.key }}”？</h2>
      <p v-if="emoji" class="mt-3 inline-state">{{ workbenchLabel(emoji.workbench ?? "native") }}</p>
      <p class="mt-3 font-mono text-xs text-mute">[/{{ emoji?.key }}]</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-danger" type="button" :disabled="busy" @click="emit('confirm')"><i class="bx" :class="busy ? 'bx-loader-alt bx-spin' : 'bx-trash'" aria-hidden="true"></i>{{ busy ? "删除中" : "删除" }}</button>
      </div>
    </section>
  </DialogOverlay>
</template>
