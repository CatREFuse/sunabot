<script lang="ts">
const loadedSources = new Set<string>();
</script>

<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { authenticatedMediaPath, authenticatedThumbnailPath } from "../../composables/useAdminApi";

const props = withDefaults(defineProps<{
  src: string;
  alt?: string;
  className?: string;
  placeholderClassName?: string;
  thumbnail?: boolean;
  displaySrc?: string;
  placeholderSrc?: string;
}>(), {
  alt: "",
  className: "",
  placeholderClassName: "min-h-24",
  thumbnail: false,
  displaySrc: undefined,
  placeholderSrc: undefined
});
const emit = defineEmits<{ error: [] }>();
const mainSource = computed(() => props.displaySrc
  ?? (props.thumbnail ? authenticatedThumbnailPath(props.src) : authenticatedMediaPath(props.src)));
const placeholderSource = computed(() => props.placeholderSrc
  ?? (props.src.startsWith("data:") || props.src.startsWith("blob:")
    ? ""
    : authenticatedThumbnailPath(props.src, "placeholder")));
const state = shallowRef<"loading" | "ready" | "error">("loading");

watch(mainSource, (source) => {
  state.value = loadedSources.has(source) ? "ready" : "loading";
}, { immediate: true });

function loaded() {
  loadedSources.add(mainSource.value);
  state.value = "ready";
}

function failed() {
  state.value = "error";
  emit("error");
}
</script>

<template>
  <span class="authenticated-image" :class="placeholderClassName" :data-state="state">
    <img
      v-if="placeholderSource && state === 'loading'"
      class="authenticated-image__placeholder"
      :src="placeholderSource"
      alt=""
      aria-hidden="true"
      decoding="async"
    >
    <img
      v-if="state !== 'error'"
      class="authenticated-image__main"
      :class="className"
      :src="mainSource"
      :alt="alt"
      :loading="thumbnail ? 'lazy' : 'eager'"
      decoding="async"
      @load="loaded"
      @error="failed"
    >
    <span v-else class="authenticated-image__error"><i class="bx bx-image-alt text-xl" aria-hidden="true"></i><span class="sr-only">图片不可用</span></span>
  </span>
</template>

<style scoped>
.authenticated-image { position: relative; display: grid; width: 100%; height: 100%; min-width: 0; place-items: center; overflow: hidden; background: rgb(var(--color-raised)); }
.authenticated-image__placeholder { position: absolute; inset: -12%; width: 124%; height: 124%; object-fit: cover; filter: blur(14px); transform: scale(1.04); }
.authenticated-image__main { position: relative; z-index: 1; opacity: 0; transition: opacity 220ms ease; }
.authenticated-image[data-state="ready"] .authenticated-image__main { opacity: 1; }
.authenticated-image__error { display: grid; width: 100%; height: 100%; min-height: inherit; place-items: center; color: rgb(var(--color-mute)); }
@media (prefers-reduced-motion: reduce) { .authenticated-image__main { transition: none; } }
</style>
