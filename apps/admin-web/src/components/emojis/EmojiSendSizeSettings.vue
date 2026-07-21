<script setup lang="ts">
import type { EmojiSendSize } from "../../types/emojis";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

defineProps<{
  modelValue: EmojiSendSize;
  sendSeparately: boolean;
  saving: boolean;
}>();
const emit = defineEmits<{
  change: [value: EmojiSendSize];
  separateChange: [value: boolean];
}>();

const choices: ReadonlyArray<{ value: EmojiSendSize; label: string }> = [
  { value: 64, label: "64" },
  { value: 128, label: "128" },
  { value: 256, label: "256" },
  { value: 512, label: "512" },
  { value: 1024, label: "1k" }
];
</script>

<template>
  <section class="divide-y divide-line border-y border-visible" aria-label="表情发送设置">
    <div class="flex flex-wrap items-center justify-between gap-4 py-5">
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
    </div>
    <ToggleSwitch
      :model-value="sendSeparately"
      :disabled="saving"
      label="表情单独发送"
      description="正文发送后，再发送表情"
      @update:model-value="emit('separateChange', $event)"
    />
  </section>
</template>
