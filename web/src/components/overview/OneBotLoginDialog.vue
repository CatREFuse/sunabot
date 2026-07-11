<script setup lang="ts">
import { ExternalLink, RefreshCw, X } from "lucide-vue-next";
import { computed } from "vue";
import type { OneBotLoginCheck, OneBotQrLogin } from "../../types";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{ open: boolean; busy: boolean; checking: boolean; qr: OneBotQrLogin | null; check: OneBotLoginCheck | null; error: string }>();
const emit = defineEmits<{ close: []; refresh: []; webui: [route: string] }>();
const qrSource = computed(() => {
  const direct = props.qr?.imageDataUrl?.trim() || props.qr?.imageUrl?.trim();
  if (direct) return direct;
  const qrcode = props.qr?.qrcode?.trim();
  if (!qrcode) return "";
  if (/^(?:data:image\/|blob:|https?:\/\/|\/)/i.test(qrcode)) return qrcode;
  const compact = qrcode.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/=]+$/.test(compact) ? `data:image/png;base64,${compact}` : "";
});
</script>

<template>
  <DialogOverlay :open="open" labelledby="login-title" @close="emit('close')">
    <section class="max-h-[calc(100dvh-32px)] w-full max-w-md overflow-y-auto rounded-2xl border border-visible bg-panel">
      <header class="flex items-center justify-between border-b border-line p-4 md:p-5">
        <div><p class="page-kicker">ONEBOT LOGIN</p><h2 id="login-title" class="mt-1 text-xl font-medium text-display">QQ 登录</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><X :size="19" :stroke-width="1.5" /></button>
      </header>
      <div class="grid gap-5 p-4 md:p-5">
        <div class="flex items-center justify-between gap-3">
          <strong class="text-lg font-normal text-display">{{ check?.online ? "已上线" : busy ? "正在启动" : "等待扫码" }}</strong>
          <span class="font-mono text-[10px]" :class="check?.online ? 'text-success' : 'text-mute'">{{ checking ? "[CHECKING...]" : check?.online ? "[ONLINE]" : "[WAITING]" }}</span>
        </div>
        <div class="grid min-h-72 place-items-center rounded-xl border border-line bg-page p-4">
          <AuthenticatedImage v-if="qrSource" :src="qrSource" alt="QQ 登录二维码" class-name="w-full max-w-56 bg-white p-3 [image-rendering:pixelated]" />
          <p v-else class="font-mono text-xs text-mute">{{ busy ? "[LOADING...]" : "[QR UNAVAILABLE]" }}</p>
        </div>
        <p v-if="error" class="inline-state" data-kind="error">[ERROR: {{ error }}]</p>
        <p v-else class="text-sm text-mute">使用 QQ 扫描二维码并确认登录。</p>
        <button v-if="qr?.webuiUrl" class="btn justify-self-start" type="button" @click="emit('webui', qr.webuiUrl)">打开 NapCat<ExternalLink :size="16" :stroke-width="1.5" /></button>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line p-4 md:p-5">
        <button class="btn" type="button" :disabled="busy" @click="emit('refresh')"><RefreshCw :size="16" :stroke-width="1.5" />刷新二维码</button>
      </footer>
    </section>
  </DialogOverlay>
</template>
