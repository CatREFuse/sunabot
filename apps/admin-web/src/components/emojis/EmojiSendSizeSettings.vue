<script setup lang="ts">
import type { EmojiSendSize } from "../../types/emojis";

defineProps<{
  modelValue: EmojiSendSize;
  saving: boolean;
}>();
const emit = defineEmits<{ change: [value: EmojiSendSize] }>();

const choices: ReadonlyArray<{ value: EmojiSendSize; label: string }> = [
  { value: 64, label: "64" },
  { value: 128, label: "128" },
  { value: 256, label: "256" },
  { value: 512, label: "512" },
  { value: 1024, label: "1k" }
];
</script>

<template>
  <section class="flex flex-wrap items-center justify-between gap-4 border-t border-visible py-5" aria-labelledby="emoji-send-size-title">
    <h2 id="emoji-send-size-title" class="text-sm font-medium text-display">发送尺寸</h2>
    <div class="segmented max-w-full overflow-x-auto" role="group" aria-label="表情发送尺寸">
      <button
        v-for="choice in choices"
        :key="choice.value"
        class="segmented-button min-w-12"
        type="button"
        :aria-pressed="modelValue === choice.value"
        :disabled="saving"
        @click="emit('change', choice.value)"
      >{{ choice.label }}</button>
    </div>
  </section>
</template>
