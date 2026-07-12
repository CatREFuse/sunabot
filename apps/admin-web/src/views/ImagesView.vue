<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { useImageStudio } from "../composables/useImageStudio";
import type { ImageHistoryRecord } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import ImageHistorySection from "../components/images/ImageHistorySection.vue";
import ImagePreviewDialog from "../components/images/ImagePreviewDialog.vue";
import SelfieReferenceSettings from "../components/settings/SelfieReferenceSettings.vue";

const data = useImageStudio();
const message = shallowRef("");
const previewImage = shallowRef<ImageHistoryRecord | null>(null);
const messageKind = computed(() => {
  if (message.value === "已下载") return "success";
  if (message.value && message.value !== "下载中") return "error";
  return undefined;
});
const historyError = computed(() => data.error.value);

onMounted(() => void data.load());
onBeforeUnmount(data.dispose);

async function downloadImage(image: ImageHistoryRecord) {
  message.value = "下载中";
  try {
    await data.download(image);
    message.value = "已下载";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "下载失败";
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="图像">
        <template #actions>
          <span class="inline-state" :data-kind="messageKind">{{ message }}</span>
          <button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新历史" @click="data.load(true)"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
        </template>
      </PageHeader>

      <p v-if="historyError" class="inline-state mt-6" data-kind="error">{{ historyError }}</p>

      <SelfieReferenceSettings class="mt-8" />

      <ImageHistorySection
        :images="data.images.value"
        :loading="data.loading.value"
        :downloading-id="data.downloadingId.value"
        @preview="previewImage = $event"
        @download="downloadImage"
      />
    </div>

    <ImagePreviewDialog
      :image="previewImage"
      :downloading="Boolean(previewImage && data.downloadingId.value === previewImage.id)"
      @close="previewImage = null"
      @download="downloadImage"
    />
  </div>
</template>
