<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
withDefaults(defineProps<{ label: string; description?: string; disabled?: boolean }>(), {
  description: "",
  disabled: false
});
</script>

<template>
  <label
    class="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-4"
    :class="{ 'cursor-not-allowed opacity-50': disabled }"
  >
    <span class="min-w-0">
      <span class="block text-sm text-ink">{{ label }}</span>
      <span v-if="description" class="mt-1 block text-xs leading-5 text-mute">{{ description }}</span>
    </span>
    <input v-model="model" class="peer sr-only" type="checkbox" :disabled="disabled">
    <span
      data-slot="toggle-track"
      class="relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[rgb(var(--color-interactive))]"
      :class="model ? 'border-[rgb(var(--color-interactive))] bg-[rgb(var(--color-interactive))]' : 'border-visible bg-page'"
    >
      <span
        data-slot="toggle-thumb"
        class="absolute left-0.5 top-0.5 size-[18px] rounded-full transition-[transform,background-color] duration-200"
        :class="model ? 'translate-x-5 bg-page' : 'translate-x-0 bg-disabled'"
      ></span>
    </span>
  </label>
</template>
