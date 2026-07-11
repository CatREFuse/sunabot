<script setup lang="ts">
import type { MemorySource, MemorySourceId } from "../../types";

type Source = MemorySourceId | "all";
defineProps<{ sources: readonly MemorySource[] }>();
const source = defineModel<Source>({ required: true });
</script>

<template>
  <nav class="-mx-1 overflow-x-auto px-1" aria-label="记忆类别">
    <div class="segmented w-max min-w-full md:min-w-0">
      <button class="segmented-button shrink-0" type="button" :aria-pressed="source === 'all'" @click="source = 'all'">全部</button>
      <button v-for="item in sources" :key="item.id" class="segmented-button shrink-0" type="button" :aria-pressed="source === item.id" @click="source = item.id">{{ item.title }}</button>
    </div>
  </nav>
</template>
