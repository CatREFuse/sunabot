<script setup lang="ts">
import { computed, shallowRef, useTemplateRef } from "vue";
import type { AgentAvatarInput } from "../../types";
import AgentAvatarCropDialog from "./AgentAvatarCropDialog.vue";

const SUPPORTED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const props = withDefaults(defineProps<{ label?: string; disabled?: boolean }>(), {
  label: "选择头像",
  disabled: false
});
const emit = defineEmits<{ change: [avatar: AgentAvatarInput] }>();
const input = useTemplateRef<HTMLInputElement>("input");
const selectedFile = shallowRef<File>();
const error = shallowRef("");
const cropOpen = computed(() => Boolean(selectedFile.value));

function chooseFile() {
  input.value?.click();
}

function selectFile(event: Event) {
  const target = event.currentTarget as HTMLInputElement;
  const file = target.files?.[0];
  target.value = "";
  if (!file) return;
  if (!isSupportedAvatar(file)) {
    error.value = "请选择 PNG、JPEG 或 WebP 图片。";
    return;
  }
  error.value = "";
  selectedFile.value = file;
}

function finishCrop(avatar: AgentAvatarInput) {
  selectedFile.value = undefined;
  emit("change", avatar);
}

function closeCrop() {
  selectedFile.value = undefined;
}

function isSupportedAvatar(file: File) {
  return SUPPORTED_AVATAR_TYPES.has(file.type)
    || (!file.type && /\.(?:png|jpe?g|webp)$/i.test(file.name));
}
</script>

<template>
  <div class="grid gap-2">
    <input
      ref="input"
      class="sr-only"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      aria-label="选择 WebUI 头像"
      :disabled="disabled"
      @change="selectFile"
    >
    <button class="btn min-h-10 px-4" type="button" :disabled="disabled" @click="chooseFile">{{ label }}</button>
    <p v-if="error" class="text-sm text-accent" role="alert">{{ error }}</p>
    <AgentAvatarCropDialog :open="cropOpen" :file="selectedFile" @close="closeCrop" @confirm="finishCrop" />
  </div>
</template>
