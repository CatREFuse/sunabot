<script setup lang="ts">
defineProps<{ kicker: string; title: string; description?: string }>();
</script>

<template>
  <header class="flex min-w-0 flex-col justify-between gap-6 border-b border-line pb-8 md:flex-row md:items-end">
    <div class="min-w-0">
      <p class="page-kicker">{{ kicker }}</p>
      <div class="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-4">
        <h1 class="page-title shrink-0">{{ title }}</h1>
        <div v-if="$slots.titleAfter" class="min-w-0 flex-1 pb-0.5">
          <slot name="titleAfter" />
        </div>
      </div>
      <p v-if="description" class="page-intro">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
