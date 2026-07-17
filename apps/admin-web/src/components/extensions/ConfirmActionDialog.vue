<script setup lang="ts">
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{ open: boolean; title: string; message: string; action: string; busy: boolean; danger?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <DialogOverlay :open="open" labelledby="extension-confirm-title" @close="emit('close')">
    <section class="w-full max-w-md border border-visible bg-panel p-6 md:p-8">
      <h2 id="extension-confirm-title" class="text-2xl font-medium text-display">{{ title }}</h2>
      <p class="mt-4 text-sm leading-6 text-mute">{{ message }}</p>
      <div class="mt-8 flex justify-end gap-2"><button class="btn" type="button" @click="emit('close')">取消</button><button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" type="button" :disabled="busy" @click="emit('confirm')">{{ action }}</button></div>
    </section>
  </DialogOverlay>
</template>
