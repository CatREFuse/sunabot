<script lang="ts">
interface DialogRegistration {
  root: HTMLElement;
  dismissible: boolean;
  close: () => void;
  previousFocus: HTMLElement | null;
}

const dialogStack: DialogRegistration[] = [];
let appWasInert = false;

function focusableElements(root: HTMLElement) {
  const selector = [
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function focusDialog(registration: DialogRegistration) {
  const preferred = registration.root.querySelector<HTMLElement>("[data-dialog-initial-focus], [autofocus]");
  const target = preferred ?? focusableElements(registration.root)[0] ?? registration.root;
  target.focus({ preventScroll: true });
}

function onDialogKeydown(event: KeyboardEvent) {
  const current = dialogStack.at(-1);
  if (!current) return;
  if (event.key === "Escape" && current.dismissible) {
    event.preventDefault();
    current.close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements(current.root);
  if (!focusable.length) {
    event.preventDefault();
    current.root.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function registerDialog(registration: DialogRegistration) {
  if (!dialogStack.length) {
    const app = document.querySelector<HTMLElement>("#app");
    appWasInert = Boolean(app?.hasAttribute("inert"));
    app?.setAttribute("inert", "");
    document.addEventListener("keydown", onDialogKeydown, true);
  }
  dialogStack.push(registration);
  focusDialog(registration);
}

function unregisterDialog(registration: DialogRegistration) {
  const index = dialogStack.indexOf(registration);
  if (index >= 0) dialogStack.splice(index, 1);
  if (dialogStack.length) {
    focusDialog(dialogStack.at(-1)!);
    return;
  }
  document.removeEventListener("keydown", onDialogKeydown, true);
  const app = document.querySelector<HTMLElement>("#app");
  if (!appWasInert) app?.removeAttribute("inert");
  if (registration.previousFocus?.isConnected) registration.previousFocus.focus({ preventScroll: true });
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, useAttrs, useTemplateRef, watch } from "vue";

defineOptions({ inheritAttrs: false });

type Placement = "center" | "right" | "bottom" | "full";

const props = withDefaults(defineProps<{
  open: boolean;
  placement?: Placement;
  labelledby?: string;
  ariaLabel?: string;
  dismissible?: boolean;
  zIndex?: number;
  backdrop?: "default" | "preview";
}>(), {
  placement: "center",
  labelledby: undefined,
  ariaLabel: undefined,
  dismissible: true,
  zIndex: 70,
  backdrop: "default"
});
const emit = defineEmits<{ close: [] }>();
const attrs = useAttrs();
const root = useTemplateRef<HTMLElement>("root");
let registration: DialogRegistration | undefined;

const placementClasses = computed(() => ({
  "grid place-items-center p-4": props.placement === "center",
  "flex justify-end": props.placement === "right",
  "flex items-end": props.placement === "bottom",
  "grid p-3 md:p-8": props.placement === "full",
  "bg-black/80": props.backdrop === "default",
  "bg-black/90": props.backdrop === "preview"
}));

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      if (registration) unregisterDialog(registration);
      registration = undefined;
      return;
    }
    await nextTick();
    if (!root.value || !props.open || registration) return;
    registration = {
      root: root.value,
      dismissible: props.dismissible,
      close: () => emit("close"),
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    registerDialog(registration);
  },
  { immediate: true, flush: "post" }
);

onBeforeUnmount(() => {
  if (registration) unregisterDialog(registration);
  registration = undefined;
});

function closeFromBackdrop() {
  if (props.dismissible) emit("close");
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-overlay">
      <div
        v-if="open"
        ref="root"
        v-bind="attrs"
        class="dialog-overlay fixed inset-0"
        :class="placementClasses"
        :style="{ zIndex }"
        :data-placement="placement"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="labelledby"
        :aria-label="ariaLabel"
        tabindex="-1"
        @click.self="closeFromBackdrop"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.dialog-overlay-enter-active,
.dialog-overlay-leave-active,
.dialog-overlay-enter-active > *,
.dialog-overlay-leave-active > * {
  transition-duration: 180ms;
  transition-timing-function: ease;
}

.dialog-overlay-enter-active,
.dialog-overlay-leave-active {
  transition-property: opacity;
}

.dialog-overlay-enter-active > *,
.dialog-overlay-leave-active > * {
  transition-property: transform;
}

.dialog-overlay-enter-from,
.dialog-overlay-leave-to {
  opacity: 0;
}

.dialog-overlay-enter-from[data-placement="center"] > *,
.dialog-overlay-leave-to[data-placement="center"] > * {
  transform: translateY(8px) scale(0.985);
}

.dialog-overlay-enter-from[data-placement="right"] > *,
.dialog-overlay-leave-to[data-placement="right"] > * {
  transform: translateX(24px);
}

.dialog-overlay-enter-from[data-placement="bottom"] > *,
.dialog-overlay-leave-to[data-placement="bottom"] > * {
  transform: translateY(24px);
}
</style>
