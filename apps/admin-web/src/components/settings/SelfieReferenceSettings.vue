<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import type { SelfieReferenceImage } from "../../types";
import { useSelfieReferences } from "../../composables/useSelfieReferences";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import SelfieReferenceDialog from "./SelfieReferenceDialog.vue";

const references = useSelfieReferences();
const managerOpen = shallowRef(false);
const slots = computed<Array<SelfieReferenceImage | null>>(() => [
  ...references.images.value,
  ...Array.from({ length: Math.max(0, references.maxImages.value - references.images.value.length) }, () => null)
]);

onMounted(() => void references.load());
onBeforeUnmount(references.dispose);

function openManager() {
  managerOpen.value = true;
}
</script>

<template>
  <section class="border-t border-visible pt-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="page-kicker">SELFIE REFERENCES</p>
        <h2 class="section-title mt-2">自拍参考图</h2>
      </div>
      <span class="inline-state" :data-kind="references.status.value.kind === 'error' ? 'error' : references.images.value.length === references.maxImages.value ? 'success' : undefined">
        <i class="bx" :class="references.images.value.length === references.maxImages.value ? 'bx-check-circle' : 'bx-images'" aria-hidden="true"></i>
        {{ references.loading.value ? "读取中" : `${references.images.value.length} / ${references.maxImages.value} 张` }}
      </span>
    </div>

    <button class="mt-5 grid w-full grid-cols-3 gap-2 text-left sm:gap-3" type="button" aria-label="管理自拍参考图" @click="openManager">
      <span v-for="(image, index) in slots" :key="image?.id ?? `empty-${index}`" class="aspect-square min-w-0 overflow-hidden border border-line bg-raised transition-colors hover:border-display">
        <AuthenticatedImage
          v-if="image"
          :src="image.originalUrl"
          :display-src="image.displayUrl"
          :placeholder-src="image.placeholderUrl"
          :alt="image.fileName"
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
    :deleting-id="references.deletingId.value"
    :status="references.status.value"
    @close="managerOpen = false"
    @upload="references.upload"
    @remove="references.remove"
  />
</template>
