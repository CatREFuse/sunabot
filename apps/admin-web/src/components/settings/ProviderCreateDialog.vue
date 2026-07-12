<script setup lang="ts">
import DialogOverlay from "../ui/DialogOverlay.vue";
import { providerTypeOptions, type ProviderKind } from "./providerPresets";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; select: [kind: ProviderKind] }>();
</script>

<template>
  <DialogOverlay :open="open" labelledby="provider-create-title" @close="emit('close')">
    <section class="flex max-h-[calc(100dvh-32px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-visible bg-panel">
      <header class="flex items-center justify-between border-b border-line p-5">
        <div><p class="page-kicker">NEW PROVIDER</p><h2 id="provider-create-title" class="mt-2 text-xl font-medium text-display">选择 Provider 类型</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>
      <div class="min-h-0 overflow-y-auto px-5 pb-5">
        <button
          v-for="item in providerTypeOptions"
          :key="item.kind"
          class="grid min-h-20 w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line text-left"
          type="button"
          :aria-label="`创建 ${item.label}`"
          @click="emit('select', item.kind)"
        >
          <span class="grid size-10 place-items-center rounded-lg bg-raised text-xl text-display"><i class="bx" :class="item.icon" aria-hidden="true"></i></span>
          <span class="min-w-0"><strong class="block text-sm font-medium text-display">{{ item.label }}</strong><small class="mt-1 block text-xs text-mute">{{ item.description }}</small></span>
          <i class="bx bx-chevron-right text-xl text-mute" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  </DialogOverlay>
</template>
