<script setup lang="ts">
defineProps<{ dirty: boolean; busy: boolean; message: string; kind: string; field?: string }>();
const emit = defineEmits<{ save: []; discard: []; reload: [] }>();
</script>

<template>
  <div class="mt-10 flex min-h-16 flex-wrap items-center justify-between gap-3 border-t border-visible bg-transparent py-4">
    <span class="inline-state" :data-kind="kind === 'error' || kind === 'conflict' ? 'error' : kind === 'saved' ? 'success' : kind === 'restart' ? 'warning' : undefined">
      <span v-if="field" class="mr-2">{{ field }}</span>{{ message || (dirty ? "[UNSAVED]" : "[NO CHANGES]") }}
    </span>
    <div class="flex flex-wrap gap-2">
      <button v-if="kind === 'conflict'" class="btn" type="button" @click="emit('reload')">加载最新</button>
      <button class="btn btn-ghost" type="button" :disabled="!dirty || busy" @click="emit('discard')">放弃</button>
      <button class="btn btn-primary" type="button" :disabled="!dirty || busy" @click="emit('save')">{{ busy ? "保存中" : "保存" }}</button>
    </div>
  </div>
</template>
