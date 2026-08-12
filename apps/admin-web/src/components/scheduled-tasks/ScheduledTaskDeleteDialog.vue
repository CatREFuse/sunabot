<script setup lang="ts">
import type { ScheduledTask } from "../../types/scheduledTasks";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{
  task: ScheduledTask | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<template>
  <DialogOverlay :open="Boolean(task)" labelledby="scheduled-task-delete-title" :dismissible="!busy" @close="emit('close')">
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2 id="scheduled-task-delete-title" class="text-xl font-medium text-display">删除“{{ task?.name }}”？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">删除后将停止后续触发。</p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn btn-danger" type="button" :disabled="busy" @click="emit('confirm')">
          <i class="bx" :class="busy ? 'bx-loader-alt bx-spin' : 'bx-trash'" aria-hidden="true"></i>{{ busy ? "删除中" : "删除" }}
        </button>
      </div>
    </section>
  </DialogOverlay>
</template>
