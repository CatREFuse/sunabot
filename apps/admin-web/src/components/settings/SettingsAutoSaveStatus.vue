<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  kind: "idle" | "waiting" | "saving" | "saved" | "error" | "conflict" | "restart";
  message: string;
}>();

const message = computed(() => props.message || "已同步");
const statusKind = computed(() => {
  if (props.kind === "error" || props.kind === "conflict") return "error";
  if (props.kind === "restart") return "warning";
  if (props.kind === "saved" || props.kind === "idle") return "success";
  return undefined;
});
</script>

<template>
  <div
    data-slot="settings-auto-save-status"
    class="sticky bottom-0 z-20 mt-10 flex min-h-16 items-center border-t border-visible bg-page pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    role="status"
    aria-live="polite"
  >
    <span class="inline-state" :data-kind="statusKind">{{ message }}</span>
  </div>
</template>
