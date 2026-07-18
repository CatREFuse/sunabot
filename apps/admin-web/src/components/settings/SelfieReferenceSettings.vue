<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import type { SelfieReferenceImage } from "../../types";
import { activeAgentIdState } from "../../composables/agentScope";
import { useSelfieReferences } from "../../composables/useSelfieReferences";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import SelfieReferenceDialog from "./SelfieReferenceDialog.vue";

const references = useSelfieReferences();
const managerOpen = shallowRef(false);
const agentId = computed(() => activeAgentIdState.value || "plana");
const slots = computed<Array<SelfieReferenceImage | null>>(() => [
  ...references.images.value,
  ...Array.from({ length: Math.max(0, references.maxImages.value - references.images.value.length) }, () => null)
]);

watch(activeAgentIdState, (nextAgentId) => {
  managerOpen.value = false;
  void references.load(nextAgentId || "plana");
}, { immediate: true, flush: "sync" });
onBeforeUnmount(references.dispose);

function openManager() {
  managerOpen.value = true;
}

function upload(entries: Parameters<typeof references.upload>[1]) {
  return references.upload(agentId.value, entries);
}

function updateNote(id: string, note: string) {
  return references.updateNote(agentId.value, id, note);
}

function remove(id: string) {
  return references.remove(agentId.value, id);
}
</script>

<template>
  <section class="border-t border-visible pt-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 class="section-title">自拍参考图</h2>
        <p class="mt-1 text-xs text-mute">素材库最多 {{ references.maxImages.value }} 张，每次自拍选用 1–3 张</p>
      </div>
      <span class="inline-state" :data-kind="references.status.value.kind === 'error' ? 'error' : references.images.value.length === references.maxImages.value ? 'success' : undefined">
        <i class="bx" :class="references.images.value.length === references.maxImages.value ? 'bx-check-circle' : 'bx-images'" aria-hidden="true"></i>
        {{ references.loading.value ? "读取中" : `${references.images.value.length} / ${references.maxImages.value} 张` }}
      </span>
    </div>

    <button class="mt-5 grid w-full grid-cols-3 gap-2 text-left sm:grid-cols-6 lg:grid-cols-9" type="button" aria-label="管理自拍参考图" @click="openManager">
      <span v-for="(image, index) in slots" :key="image?.id ?? `empty-${index}`" class="aspect-square min-w-0 overflow-hidden border border-line bg-raised transition-colors hover:border-display" :title="image?.note">
        <AuthenticatedImage
          v-if="image"
          :src="image.originalUrl"
          :display-src="image.displayUrl"
          :placeholder-src="image.placeholderUrl"
          :alt="image.note"
          thumbnail
          class-name="h-full w-full object-cover"
        />
        <span v-else class="grid h-full place-items-center text-mute"><i class="bx bx-image-add text-2xl" aria-hidden="true"></i></span>
      </span>
    </button>

    <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
      <span class="inline-state" :data-kind="references.status.value.kind === 'idle' ? undefined : references.status.value.kind">{{ references.status.value.message }}</span>
      <button class="btn" type="button" @click="openManager"><i class="bx bx-images" aria-hidden="true"></i>管理参考图</button>
    </div>
  </section>

  <SelfieReferenceDialog
    :open="managerOpen"
    :images="references.images.value"
    :max-images="references.maxImages.value"
    :loading="references.loading.value"
    :uploading="references.uploading.value"
    :updating-id="references.updatingId.value"
    :deleting-id="references.deletingId.value"
    :status="references.status.value"
    @close="managerOpen = false"
    @upload="upload"
    @update-note="updateNote"
    @remove="remove"
  />
</template>
