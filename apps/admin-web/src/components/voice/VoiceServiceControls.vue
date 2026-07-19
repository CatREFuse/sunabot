<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type {
  VoiceProviderStatus,
  VoiceServiceAction,
} from "../../types/voice";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = withDefaults(
  defineProps<{
    provider: VoiceProviderStatus | null;
    action?: VoiceServiceAction;
    error?: string;
    message?: string;
  }>(),
  { action: "", error: "", message: "" },
);
const emit = defineEmits<{
  check: [];
  start: [];
  stop: [];
}>();

const stopConfirmationOpen = shallowRef(false);
const busy = computed(() => Boolean(props.action));
const controlsAvailable = computed(
  () => props.provider?.controlsAvailable === true,
);
const serviceState = computed(() => props.provider?.serviceState ?? "unknown");
const stateLabel = computed(() => {
  if (props.action === "check") return "检测中";
  if (props.action === "start") return "启动中";
  if (props.action === "stop") return "关闭中";
  if (props.provider?.ready) return "可用";
  if (serviceState.value === "running") return "运行中";
  if (serviceState.value === "stopped") return "已关闭";
  return props.provider ? "不可用" : "未检测";
});
const stateKind = computed(() => {
  if (busy.value || !props.provider) return undefined;
  if (props.provider.ready) return "success";
  return serviceState.value === "stopped" ? undefined : "error";
});
const detail = computed(() => {
  if (props.provider?.message) return props.provider.message;
  if (props.provider?.latencyMs != null)
    return `响应 ${props.provider.latencyMs} ms`;
  if (props.provider && !controlsAvailable.value) return "服务管理不可用";
  return "本地语音服务";
});
const startDisabled = computed(
  () =>
    busy.value ||
    !controlsAvailable.value ||
    props.provider?.ready === true ||
    serviceState.value === "running",
);
const stopDisabled = computed(
  () =>
    busy.value ||
    !controlsAvailable.value ||
    serviceState.value === "stopped",
);

function confirmStop() {
  stopConfirmationOpen.value = false;
  emit("stop");
}
</script>

<template>
  <section aria-labelledby="voice-service-title">
    <header>
      <h2 id="voice-service-title" class="section-title">语音服务</h2>
      <p class="mt-1 text-xs leading-5 text-mute">
        MOSS-TTS-Nano 本地合成服务
      </p>
    </header>

    <div
      class="mt-6 flex flex-col items-stretch justify-between gap-4 border-y border-line py-5 sm:flex-row sm:items-center"
    >
      <div class="min-w-0">
        <span class="block text-sm text-ink">MOSS-TTS-Nano</span>
        <span class="mt-1 block text-xs leading-5 text-mute">{{ detail }}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <span class="inline-state mr-auto sm:mr-2" :data-kind="stateKind">
          {{ stateLabel }}
        </span>
        <button
          class="btn"
          type="button"
          :disabled="busy"
          @click="emit('check')"
        >
          <i
            class="bx"
            :class="
              action === 'check' ? 'bx-loader-alt bx-spin' : 'bx-pulse'
            "
            aria-hidden="true"
          ></i>
          {{ action === "check" ? "检测中" : "检测服务" }}
        </button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="startDisabled"
          @click="emit('start')"
        >
          <i
            class="bx"
            :class="
              action === 'start' ? 'bx-loader-alt bx-spin' : 'bx-play'
            "
            aria-hidden="true"
          ></i>
          {{ action === "start" ? "启动中" : "启动服务" }}
        </button>
        <button
          class="btn btn-danger"
          type="button"
          :disabled="stopDisabled"
          @click="stopConfirmationOpen = true"
        >
          <i
            class="bx"
            :class="
              action === 'stop' ? 'bx-loader-alt bx-spin' : 'bx-stop'
            "
            aria-hidden="true"
          ></i>
          {{ action === "stop" ? "关闭中" : "关闭服务" }}
        </button>
      </div>
    </div>

    <p
      v-if="error"
      class="mt-4 inline-state"
      data-kind="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="message"
      class="mt-4 inline-state"
      data-kind="success"
      aria-live="polite"
    >
      {{ message }}
    </p>
  </section>

  <DialogOverlay
    :open="stopConfirmationOpen"
    labelledby="voice-service-stop-title"
    :dismissible="!busy"
    @close="stopConfirmationOpen = false"
  >
    <section class="w-full max-w-md rounded border border-visible bg-panel p-6">
      <h2
        id="voice-service-stop-title"
        class="text-xl font-medium text-display"
      >
        关闭语音服务？
      </h2>
      <p class="mt-3 text-sm leading-6 text-mute">
        语音消息将在服务重新启动前不可用。
      </p>
      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="busy"
          @click="stopConfirmationOpen = false"
        >
          取消
        </button>
        <button
          class="btn btn-danger"
          type="button"
          :disabled="busy"
          @click="confirmStop"
        >
          <i class="bx bx-stop" aria-hidden="true"></i>关闭服务
        </button>
      </div>
    </section>
  </DialogOverlay>
</template>
