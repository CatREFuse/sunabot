<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ dirty: boolean; busy: boolean; message: string; kind: string; field?: string }>();
const emit = defineEmits<{ save: []; discard: []; reload: [] }>();
const statusMessage = computed(() => {
  if (!props.message) return props.dirty ? "未保存" : "没有修改";
  return props.message;
});
</script>

<template>
  <div
    data-slot="settings-save-bar"
    class="sticky bottom-0 z-20 mt-10 flex min-h-16 flex-wrap items-center justify-between gap-3 border-t border-visible bg-page pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
  >
    <span class="inline-state" :data-kind="kind === 'error' || kind === 'conflict' ? 'error' : kind === 'saved' ? 'success' : kind === 'restart' ? 'warning' : undefined">
      {{ statusMessage }}
    </span>
    <div class="flex flex-wrap gap-2">
      <button v-if="kind === 'conflict'" class="btn" type="button" @click="emit('reload')">加载最新</button>
      <button class="btn btn-ghost" type="button" :disabled="!dirty || busy" @click="emit('discard')">放弃</button>
      <button class="btn btn-primary" type="button" :disabled="!dirty || busy" @click="emit('save')">{{ busy ? "保存中" : "保存" }}</button>
    </div>
  </div>
</template>
