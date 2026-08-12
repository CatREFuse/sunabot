<script setup lang="ts">
export interface QuasarSegmentedOption {
  label: string;
  value: string;
  disabled?: boolean;
}

const model = defineModel<string>({ required: true });
withDefaults(defineProps<{
  label: string;
  options: readonly QuasarSegmentedOption[];
  disabled?: boolean;
}>(), {
  disabled: false
});
</script>

<template>
  <div
    class="quasar-segmented"
    role="group"
    :aria-label="label"
    :aria-disabled="disabled || undefined"
  >
    <button
      v-for="option in options"
      :key="option.value"
      class="quasar-segmented-option"
      type="button"
      data-cursor="action"
      :aria-pressed="model === option.value"
      :disabled="disabled || option.disabled"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.quasar-segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
  max-width: 100%;
  padding: 6px;
  border-radius: 12px;
  background: var(--quasar-raised);
  transition: opacity 125ms var(--quasar-motion-ease);
}

.quasar-segmented-option {
  min-height: 28px;
  border: 0;
  border-radius: 8px;
  padding: 4px 9px;
  background: transparent;
  color: var(--quasar-tertiary);
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
  white-space: nowrap;
  transition:
    color 125ms var(--quasar-motion-ease),
    background-color 125ms var(--quasar-motion-ease),
    transform 125ms var(--quasar-motion-ease);
}

.quasar-segmented-option:hover:not(:disabled) {
  color: var(--quasar-ink);
}

.quasar-segmented-option:active:not(:disabled) {
  transform: scale(0.97);
}

.quasar-segmented-option[aria-pressed="true"] {
  background: var(--quasar-accent);
  color: #fff;
  font-weight: 500;
}

.quasar-segmented-option:focus-visible {
  outline: 2px solid var(--quasar-ink);
  outline-offset: 2px;
}

.quasar-segmented-option:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

@media (max-width: 520px) {
  .quasar-segmented {
    justify-content: flex-start;
  }
}
</style>
