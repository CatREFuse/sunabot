<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

export type DynamicCursorMode = "system" | "dot" | "follow";
type CursorShape = "dot" | "action" | "caret";

const props = defineProps<{ mode: DynamicCursorMode }>();
const visible = ref(false);
const pressed = ref(false);
const shape = ref<CursorShape>("dot");
const target = reactive({ x: 0, y: 0 });
const visual = reactive({ x: 0, y: 0, angle: 0, stretch: 1 });
let animationFrame = 0;

const cursorStyle = computed(() => ({
  transform: `translate3d(${visual.x - 25}px, ${visual.y - 25}px, 0)`
}));

const shapeStyle = computed(() => ({
  transform: shape.value === "caret"
    ? "none"
    : `rotate(${visual.angle}deg) scale(${visual.stretch}, ${Math.cbrt(1 / visual.stretch)})`
}));

function updateShape(targetElement: EventTarget | null) {
  const element = targetElement instanceof Element ? targetElement : null;
  if (element?.closest("input, textarea, [contenteditable='true']")) {
    shape.value = "caret";
    return;
  }
  if (element?.closest("button, a, [role='button'], [data-cursor='action']")) {
    shape.value = "action";
    return;
  }
  shape.value = "dot";
}

function handlePointerMove(event: PointerEvent) {
  if (event.pointerType && event.pointerType !== "mouse") return;
  if (!visible.value) {
    visual.x = event.clientX;
    visual.y = event.clientY;
  }
  target.x = event.clientX;
  target.y = event.clientY;
  visible.value = true;
  updateShape(event.target);
}

function handlePointerDown() {
  pressed.value = true;
}

function handlePointerUp() {
  pressed.value = false;
}

function handlePointerLeave() {
  visible.value = false;
  pressed.value = false;
  shape.value = "dot";
}

function animate() {
  const dx = target.x - visual.x;
  const dy = target.y - visual.y;
  const distance = Math.hypot(dx, dy);
  const follow = props.mode === "follow";
  const interpolation = follow ? 0.18 : 1;

  visual.x += dx * interpolation;
  visual.y += dy * interpolation;
  visual.angle = distance > 0.5 ? Math.atan2(dy, dx) * 180 / Math.PI : visual.angle;
  visual.stretch = Math.max(1, Math.min(Math.pow(distance / (follow ? 15 : 5), 0.25), 2.5));
  if (distance < 0.5) visual.stretch = 1;
  animationFrame = requestAnimationFrame(animate);
}

function syncNativeCursor() {
  document.documentElement.classList.toggle("quasar-demo-cursor-active", props.mode !== "system");
  if (props.mode === "system") {
    visible.value = false;
    pressed.value = false;
  }
}

onMounted(() => {
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerdown", handlePointerDown, { passive: true });
  window.addEventListener("pointerup", handlePointerUp, { passive: true });
  document.documentElement.addEventListener("mouseleave", handlePointerLeave);
  syncNativeCursor();
  animationFrame = requestAnimationFrame(animate);
});

watch(() => props.mode, syncNativeCursor);

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerdown", handlePointerDown);
  window.removeEventListener("pointerup", handlePointerUp);
  document.documentElement.removeEventListener("mouseleave", handlePointerLeave);
  document.documentElement.classList.remove("quasar-demo-cursor-active");
  cancelAnimationFrame(animationFrame);
});
</script>

<template>
  <div
    v-show="mode !== 'system' && visible"
    class="dynamic-cursor"
    :style="cursorStyle"
    aria-hidden="true"
  >
    <span
      class="dynamic-cursor-shape"
      :class="[`is-${shape}`, { 'is-pressed': pressed }]"
      :style="shapeStyle"
    ></span>
  </div>
</template>

<style scoped>
.dynamic-cursor {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 200;
  display: flex;
  width: 50px;
  height: 50px;
  align-items: center;
  justify-content: center;
  padding: 0;
  pointer-events: none;
  will-change: transform;
  mix-blend-mode: difference;
}

.dynamic-cursor-shape {
  display: block;
  width: 15px;
  height: 15px;
  border: 0 solid #fff;
  border-radius: 999px;
  background: #fff;
  pointer-events: none;
  transition:
    width 100ms cubic-bezier(0.1, 0.28, 0.45, 0.75),
    height 100ms cubic-bezier(0.1, 0.28, 0.45, 0.75),
    border-width 100ms cubic-bezier(0.1, 0.28, 0.45, 0.75),
    border-radius 100ms cubic-bezier(0.1, 0.28, 0.45, 0.75),
    background-color 100ms cubic-bezier(0.1, 0.28, 0.45, 0.75);
}

.dynamic-cursor-shape.is-action {
  width: 40px;
  height: 40px;
  border-width: 2px;
  background: transparent;
}

.dynamic-cursor-shape.is-caret {
  width: 4px;
  height: 24px;
  border-radius: 2px;
}

.dynamic-cursor-shape.is-pressed {
  width: 10px;
  height: 10px;
  border-width: 0;
  background: #fff;
}

@media (pointer: coarse), (prefers-reduced-motion: reduce) {
  .dynamic-cursor {
    display: none !important;
  }
}
</style>

<style>
@media (pointer: fine) and (prefers-reduced-motion: no-preference) {
  html.quasar-demo-cursor-active .quasar-demo-shell,
  html.quasar-demo-cursor-active .quasar-demo-shell * {
    cursor: none !important;
  }
}
</style>
