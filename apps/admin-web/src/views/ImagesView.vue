<script setup lang="ts">
import { RefreshCw } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { useImageStudio } from "../composables/useImageStudio";
import type { ImageHistoryRecord } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import ImageHistorySection from "../components/images/ImageHistorySection.vue";
import ImagePreviewDialog from "../components/images/ImagePreviewDialog.vue";

const data = useImageStudio();
const message = shallowRef("");
const previewImage = shallowRef<ImageHistoryRecord | null>(null);
const messageKind = computed(() => message.value.startsWith("[ERROR") ? "error" : message.value === "[DOWNLOADED]" ? "success" : undefined);
const historyError = computed(() => message.value.startsWith("[ERROR") ? "" : data.error.value);

onMounted(() => void data.load());
onBeforeUnmount(data.dispose);

async function downloadImage(image: ImageHistoryRecord) {
  message.value = "[DOWNLOADING...]";
  try {
    await data.download(image);
    message.value = "[DOWNLOADED]";
  } catch (error) {
    message.value = `[ERROR: ${error instanceof Error ? error.message : "下载失败"}]`;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="IMAGE STUDIO" title="图像">
        <template #actions>
          <span class="inline-state" :data-kind="messageKind">{{ message }}</span>
          <button class="icon-btn" type="button" :disabled="data.loading.value" aria-label="刷新历史" @click="data.load"><RefreshCw :size="18" :stroke-width="1.5" /></button>
        </template>
      </PageHeader>

      <p v-if="historyError" class="inline-state mt-6" data-kind="error">[ERROR: {{ historyError }}]</p>

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
