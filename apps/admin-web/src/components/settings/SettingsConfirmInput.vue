<script setup lang="ts">
import { computed, shallowRef, useAttrs, watch } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  modelValue?: string | number;
  modelModifiers?: { number?: boolean; trim?: boolean };
  confirmLabel?: string;
}>(), {
  modelModifiers: () => ({}),
  confirmLabel: "确认修改"
});
const emit = defineEmits<{
  "update:modelValue": [value: string | number];
  confirm: [];
}>();
const attrs = useAttrs();
const draft = shallowRef(String(props.modelValue ?? ""));
const disabled = computed(() => attrs.disabled === true || attrs.disabled === "");
const readonly = computed(() => attrs.readonly === true || attrs.readonly === "");
const nextValue = computed<string | number>(() => {
  const value = props.modelModifiers.trim ? draft.value.trim() : draft.value;
  if (props.modelModifiers.number || attrs.type === "number") {
    const parsed = Number(value);
    return value === "" || Number.isNaN(parsed) ? value : parsed;
  }
  return value;
});
const dirty = computed(() => !Object.is(nextValue.value, props.modelValue ?? ""));

watch(
  () => props.modelValue,
  (value) => {
    draft.value = String(value ?? "");
  }
);

function updateDraft(event: Event) {
  draft.value = (event.target as HTMLInputElement).value;
}

function confirm() {
  if (!dirty.value || disabled.value || readonly.value) return;
  emit("update:modelValue", nextValue.value);
  emit("confirm");
}
</script>

<template>
  <span class="relative block min-w-0">
    <input
      v-bind="attrs"
      :value="draft"
      class="control !pr-12"
      data-settings-confirm-input
      @input="updateDraft"
      @keydown.enter.prevent="confirm"
    >
    <button
      v-if="!readonly"
      class="absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded text-base transition-colors disabled:cursor-default disabled:text-disabled"
      :class="dirty ? 'bg-display text-page' : 'text-mute'"
      type="button"
      data-settings-confirm
      :data-confirm-label="confirmLabel"
      aria-label="确认修改"
      :title="confirmLabel"
      :disabled="disabled || !dirty"
      @click="confirm"
    >
      <i class="bx bx-check" aria-hidden="true"></i>
    </button>
  </span>
</template>
