<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import AuthenticatedImage from "./AuthenticatedImage.vue";

const props = withDefaults(defineProps<{
  src?: string;
  name?: string;
  size?: "sm" | "md" | "lg";
}>(), {
  src: "",
  name: "",
  size: "md"
});
const failed = shallowRef(false);
const sizeClass = computed(() => props.size === "sm" ? "size-8" : props.size === "lg" ? "size-11" : "size-10");

watch(() => props.src, () => { failed.value = false; });
</script>

<template>
  <span class="inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-raised font-mono text-[10px] font-medium text-mute ring-1 ring-inset ring-line" :class="sizeClass" :aria-label="name || '头像'">
    <AuthenticatedImage
      v-if="src && !failed"
      :src="src"
      :alt="name ? `${name}的头像` : '头像'"
      class-name="h-full w-full object-cover"
      placeholder-class-name="h-full w-full text-[0px]"
      @error="failed = true"
    />
    <span v-else class="h-full w-full" aria-hidden="true"></span>
  </span>
</template>
