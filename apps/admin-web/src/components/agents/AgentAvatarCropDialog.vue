<script setup lang="ts">
import { nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from "vue";
import type { AgentAvatarInput } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

const CROP_SIZE = 384;
const props = withDefaults(defineProps<{ open: boolean; file?: File }>(), {
  file: undefined
});
const emit = defineEmits<{
  close: [];
  confirm: [avatar: AgentAvatarInput];
}>();
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const sourceImage = shallowRef<HTMLImageElement>();
const loading = shallowRef(false);
const error = shallowRef("");
const zoom = shallowRef(1);
const offsetX = shallowRef(0);
const offsetY = shallowRef(0);
let sourceUrl = "";
let dragging = false;
let dragStart = { clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 };

watch(() => props.file, (file) => {
  releaseSourceUrl();
  sourceImage.value = undefined;
  loading.value = Boolean(file);
  error.value = "";
  resetCrop();
  if (!file) return;
  const url = URL.createObjectURL(file);
  sourceUrl = url;
  const image = new Image();
  image.onload = () => {
    if (sourceUrl !== url) return;
    releaseSourceUrl();
    sourceImage.value = image;
    loading.value = false;
    void nextTick(drawCrop);
  };
  image.onerror = () => {
    if (sourceUrl !== url) return;
    releaseSourceUrl();
    loading.value = false;
    error.value = "图片读取失败，请重新选择。";
  };
  image.src = url;
}, { immediate: true });

onBeforeUnmount(releaseSourceUrl);

function resetCrop() {
  zoom.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
  drawCrop();
}

function drawCrop() {
  const target = canvas.value;
  const image = sourceImage.value;
  if (!target) return;
  const context = target.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  if (!image) return;
  const metrics = drawMetrics(image);
  context.save();
  context.beginPath();
  context.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
  context.clip();
  context.drawImage(
    image,
    (CROP_SIZE - metrics.width) / 2 + offsetX.value,
    (CROP_SIZE - metrics.height) / 2 + offsetY.value,
    metrics.width,
    metrics.height
  );
  context.restore();
}

function drawMetrics(image = sourceImage.value) {
  if (!image) return { width: CROP_SIZE, height: CROP_SIZE };
  const scale = Math.max(CROP_SIZE / image.naturalWidth, CROP_SIZE / image.naturalHeight) * zoom.value;
  return { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
}

function clampOffsets() {
  const metrics = drawMetrics();
  const maxX = Math.max(0, (metrics.width - CROP_SIZE) / 2);
  const maxY = Math.max(0, (metrics.height - CROP_SIZE) / 2);
  offsetX.value = clamp(offsetX.value, -maxX, maxX);
  offsetY.value = clamp(offsetY.value, -maxY, maxY);
}

function updateZoom(event: Event) {
  zoom.value = Number((event.currentTarget as HTMLInputElement).value);
  clampOffsets();
  drawCrop();
}

function beginDrag(event: PointerEvent) {
  if (!sourceImage.value) return;
  dragging = true;
  dragStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    offsetX: offsetX.value,
    offsetY: offsetY.value
  };
  (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent) {
  if (!dragging || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const ratio = rect.width ? CROP_SIZE / rect.width : 1;
  offsetX.value = dragStart.offsetX + (event.clientX - dragStart.clientX) * ratio;
  offsetY.value = dragStart.offsetY + (event.clientY - dragStart.clientY) * ratio;
  clampOffsets();
  drawCrop();
}

function endDrag(event: PointerEvent) {
  dragging = false;
  const target = event.currentTarget as HTMLCanvasElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

function moveWithKeyboard(event: KeyboardEvent) {
  const movement: Record<string, readonly [number, number]> = {
    ArrowLeft: [-8, 0],
    ArrowRight: [8, 0],
    ArrowUp: [0, -8],
    ArrowDown: [0, 8]
  };
  const delta = movement[event.key];
  if (!delta || !sourceImage.value) return;
  event.preventDefault();
  offsetX.value += delta[0];
  offsetY.value += delta[1];
  clampOffsets();
  drawCrop();
}

function confirm() {
  if (!canvas.value || !sourceImage.value) return;
  drawCrop();
  emit("confirm", { fileName: "avatar.png", dataBase64: canvas.value.toDataURL("image/png") });
}

function releaseSourceUrl() {
  if (!sourceUrl) return;
  URL.revokeObjectURL(sourceUrl);
  sourceUrl = "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
</script>

<template>
  <DialogOverlay :open="open" labelledby="agent-avatar-crop-title" @close="emit('close')">
    <section class="avatar-crop-dialog w-full max-w-xl overflow-y-auto border border-visible bg-panel p-5 sm:p-8">
      <header class="flex items-center justify-between gap-4">
        <div>
          <h2 id="agent-avatar-crop-title" class="text-2xl font-medium text-display">裁剪头像</h2>
          <p class="mt-1 text-sm text-mute">拖动图片调整位置</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭裁图" @click="emit('close')">
          <i class="bx bx-x" aria-hidden="true"></i>
        </button>
      </header>

      <div class="avatar-crop-stage mx-auto mt-6">
        <canvas
          ref="canvas"
          class="avatar-crop-canvas"
          :width="CROP_SIZE"
          :height="CROP_SIZE"
          tabindex="0"
          aria-label="头像裁剪区域"
          @pointerdown="beginDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
          @keydown="moveWithKeyboard"
        >当前浏览器不支持裁图。</canvas>
        <span v-if="loading" class="avatar-crop-loading">读取中</span>
      </div>

      <p v-if="error" class="mt-4 text-sm text-accent" role="alert">{{ error }}</p>
      <label class="field mt-6">
        <span class="field-label">缩放</span>
        <input
          class="w-full accent-current"
          type="range"
          min="1"
          max="3"
          step="0.01"
          :value="zoom"
          :disabled="loading || Boolean(error)"
          aria-label="缩放头像"
          @input="updateZoom"
        >
      </label>

      <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button class="btn" type="button" :disabled="loading || Boolean(error)" @click="resetCrop">重置</button>
        <div class="flex gap-3">
          <button class="btn" type="button" @click="emit('close')">取消</button>
          <button class="btn btn-primary" type="button" :disabled="loading || Boolean(error)" @click="confirm">使用头像</button>
        </div>
      </div>
    </section>
  </DialogOverlay>
</template>

<style scoped>
.avatar-crop-dialog { max-height: min(92vh, 760px); }
.avatar-crop-stage { position: relative; width: min(76vw, 384px); aspect-ratio: 1; border-radius: 9999px; overflow: hidden; background: rgb(var(--color-raised)); box-shadow: inset 0 0 0 1px rgb(var(--color-visible)); }
.avatar-crop-canvas { width: 100%; height: 100%; border-radius: inherit; cursor: grab; touch-action: none; }
.avatar-crop-canvas:active { cursor: grabbing; }
.avatar-crop-canvas:focus-visible { outline: 2px solid rgb(var(--color-display)); outline-offset: 4px; }
.avatar-crop-loading { position: absolute; inset: 0; display: grid; place-items: center; color: rgb(var(--color-mute)); font-size: 0.875rem; }
</style>
