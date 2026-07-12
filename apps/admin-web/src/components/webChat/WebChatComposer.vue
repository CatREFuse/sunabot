<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  sending: boolean;
  error: string;
}>();
const emit = defineEmits<{ submit: [] }>();
const model = defineModel<string>({ required: true });
const sendable = computed(() => {
  const text = model.value.trim();
  return text.length > 0 && text.length <= 16_000 && !props.sending;
});
const characterCount = computed(() => model.value.length.toLocaleString("zh-CN"));

function keydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (sendable.value) emit("submit");
}
</script>

<template>
  <footer class="border-t border-visible bg-panel px-4 py-4 md:px-8 md:py-5">
    <form class="mx-auto grid max-w-4xl gap-3" @submit.prevent="emit('submit')">
      <label class="grid gap-2">
        <span class="meta-label">消息</span>
        <span class="flex min-w-0 items-end gap-3 border-b border-visible pb-2 focus-within:border-display">
          <textarea
            v-model="model"
            class="max-h-40 min-h-12 min-w-0 flex-1 resize-none bg-transparent py-2 font-mono text-sm leading-6 text-ink outline-none placeholder:text-disabled"
            rows="1"
            maxlength="16000"
            placeholder="输入消息"
            aria-label="消息"
            @keydown="keydown"
          ></textarea>
          <button
            class="grid size-12 shrink-0 place-items-center text-mute transition-colors duration-200 hover:text-display disabled:text-disabled"
            type="submit"
            :disabled="!sendable"
            aria-label="发送"
          >
            <i class="bx bx-send text-[30px]" aria-hidden="true"></i>
          </button>
        </span>
      </label>
      <div class="flex min-h-5 flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-disabled">
        <span>{{ sending ? "正在发送" : "Enter 发送 · Shift+Enter 换行" }}</span>
        <span>{{ characterCount }} / 16,000</span>
      </div>
      <p v-if="error" class="font-mono text-xs text-accent" role="alert">{{ error }}</p>
    </form>
  </footer>
</template>
