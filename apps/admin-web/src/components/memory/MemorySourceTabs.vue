<script setup lang="ts">
import type { MemorySource, MemorySourceId } from "../../types";

defineProps<{ sources: readonly MemorySource[] }>();
const source = defineModel<MemorySourceId>({ required: true });
</script>

<template>
  <nav class="-mx-1 overflow-x-auto px-1" aria-label="记忆类别">
    <div class="segmented w-max min-w-full md:min-w-0">
      <button v-for="item in sources" :key="item.id" class="segmented-button shrink-0" type="button" :aria-pressed="source === item.id" @click="source = item.id">{{ item.title }}</button>
    </div>
  </nav>
</template>
