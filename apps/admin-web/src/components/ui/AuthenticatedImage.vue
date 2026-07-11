<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from "vue";
import { apiBlob, authenticatedMediaPath } from "../../composables/useAdminApi";

const props = withDefaults(defineProps<{ src: string; alt?: string; className?: string; placeholderClassName?: string }>(), {
  alt: "",
  className: "",
  placeholderClassName: "min-h-24"
});
const emit = defineEmits<{ error: [] }>();
const objectUrl = shallowRef("");
const state = shallowRef<"loading" | "ready" | "error">("loading");
let controller: AbortController | undefined;

watch(
  () => props.src,
  (source, _previous, onCleanup) => {
    release();
    controller = new AbortController();
    const active = controller;
    state.value = "loading";
    onCleanup(release);
    if (!source) {
      state.value = "error";
      return;
    }
    if (source.startsWith("data:") || source.startsWith("blob:")) {
      objectUrl.value = source;
      state.value = "ready";
      return;
    }
    const path = authenticatedMediaPath(source);
    void apiBlob(path, { signal: active.signal })
      .then((blob) => {
        if (active.signal.aborted) return;
        objectUrl.value = URL.createObjectURL(blob);
        state.value = "ready";
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        state.value = "error";
        emit("error");
      });
  },
  { immediate: true }
);

onBeforeUnmount(release);

function release() {
  controller?.abort();
  controller = undefined;
  if (objectUrl.value.startsWith("blob:")) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
}
</script>

<template>
  <div v-if="state === 'loading'" class="grid place-items-center bg-raised font-mono text-xs text-mute" :class="placeholderClassName">[LOADING...]</div>
  <img v-else-if="state === 'ready'" :src="objectUrl" :alt="alt" :class="className">
  <div v-else class="grid place-items-center bg-raised font-mono text-xs text-mute" :class="placeholderClassName">[IMAGE UNAVAILABLE]</div>
</template>
