<script setup lang="ts">
import { computed } from "vue";
import type { OneBotQrLogin } from "../../types";
import { formatFullDateTime } from "../../utils/format";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import IdentityAvatar from "../ui/IdentityAvatar.vue";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  accountId: string;
  accountLabel: string;
  busy: boolean;
  checking: boolean;
  snapshot: OneBotQrLogin | null;
  error: string;
  confirmingLogout: boolean;
}>();
const emit = defineEmits<{
  close: [];
  refresh: [];
  webui: [route: string];
  requestLogout: [];
  cancelLogout: [];
  logout: [];
}>();
const qrSource = computed(() => {
  const direct = props.snapshot?.imageDataUrl?.trim() || props.snapshot?.imageUrl?.trim();
  if (direct) return direct;
  const qrcode = props.snapshot?.qrcode?.trim();
  if (!qrcode) return "";
  if (/^(?:data:image\/|blob:|https?:\/\/|\/)/i.test(qrcode)) return qrcode;
  const compact = qrcode.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/=]+$/.test(compact) ? `data:image/png;base64,${compact}` : "";
});
const recoveringLogin = computed(() => props.snapshot?.action === "recover_login");
const phaseLabel = computed(() => recoveringLogin.value ? "正在恢复登录" : ({
  online: "已登录",
  connecting: "正在连接 OneBot",
  restarting: "正在退出",
  starting: "正在获取二维码",
  waiting_scan: "等待扫码",
  expired: "二维码已过期"
}[props.snapshot?.phase ?? "starting"]));
const effectiveError = computed(() => props.error || props.snapshot?.loginError || props.snapshot?.error || "");
const qq = computed(() => props.snapshot?.data?.user_id ?? "--");
const nickname = computed(() => props.snapshot?.data?.nickname || "QQ Bot");
const avatar = computed(() => /^\d{5,12}$/.test(String(qq.value)) ? `/api/media/qq-avatar?kind=user&id=${qq.value}` : "");
</script>

<template>
  <DialogOverlay :open="open" labelledby="login-title" @close="emit('close')">
    <section class="max-h-[calc(100dvh-32px)] w-full max-w-md overflow-y-auto rounded border border-visible bg-panel">
      <header class="flex items-center justify-between gap-4 border-b border-line p-4 md:p-5">
        <div class="min-w-0">
          <h2 id="login-title" class="text-xl font-medium text-display">QQ 登录</h2>
          <p class="mt-1 truncate font-mono text-[10px] text-mute">{{ accountLabel }} · {{ accountId }}</p>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
      </header>
      <div class="grid gap-5 p-4 md:p-5">
        <div class="flex items-center justify-between gap-3">
          <strong class="text-lg font-normal text-display">{{ phaseLabel }}</strong>
          <span v-if="checking" class="font-mono text-[10px] text-mute">检查中</span>
        </div>
        <div v-if="snapshot?.online" class="flex min-h-72 flex-col items-center justify-center gap-4 rounded border border-line bg-page p-6 text-center">
          <IdentityAvatar :src="avatar" :name="nickname" size="lg" />
          <div><strong class="block text-xl font-medium text-display">{{ nickname }}</strong><span class="mt-1 block font-mono text-xs text-mute">QQ {{ qq }}</span></div>
          <p class="max-w-xs text-sm text-mute">{{ snapshot.connected ? "QQ 与 OneBot 已连接。" : "QQ 已登录，正在连接 OneBot。" }}</p>
        </div>
        <div v-else class="grid min-h-72 place-items-center rounded border border-line bg-page p-4">
          <AuthenticatedImage v-if="qrSource" :src="qrSource" alt="QQ 登录二维码" class-name="w-full max-w-56 bg-white p-3 [image-rendering:pixelated]" />
          <div v-else class="grid justify-items-center gap-3 text-mute"><i class="bx bx-loader-alt bx-spin text-4xl" aria-hidden="true"></i><p class="font-mono text-xs">{{ busy ? "加载中" : "等待二维码" }}</p></div>
        </div>
        <p v-if="effectiveError" class="inline-state" data-kind="error">{{ effectiveError }}</p>
        <p v-else-if="recoveringLogin" class="text-sm text-mute">正在准备新的登录二维码。</p>
        <p v-else-if="snapshot?.online" class="text-sm text-mute">可以退出当前 QQ，再扫描新的账号。</p>
        <p v-else class="text-sm text-mute">使用手机 QQ 扫码并确认，二维码会自动更新。</p>
        <span v-if="snapshot?.imageUpdatedAt && !snapshot.online" class="font-mono text-[10px] text-mute">更新于 {{ formatFullDateTime(snapshot.imageUpdatedAt) }}</span>
        <button v-if="snapshot?.webuiUrl" class="btn justify-self-start" type="button" @click="emit('webui', snapshot.webuiUrl)">打开 NapCat<i class="bx bx-link-external" aria-hidden="true"></i></button>
      </div>
      <footer v-if="snapshot?.online && confirmingLogout" class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 md:p-5">
        <span class="text-sm text-warning">确认退出当前 QQ？</span>
        <div class="flex gap-2"><button class="btn" type="button" :disabled="busy" @click="emit('cancelLogout')">取消</button><button class="btn btn-danger" type="button" :disabled="busy" @click="emit('logout')"><i class="bx bx-log-out" aria-hidden="true"></i>{{ busy ? "正在退出" : "确认退出" }}</button></div>
      </footer>
      <footer v-else class="flex justify-end gap-2 border-t border-line p-4 md:p-5">
        <button v-if="snapshot?.online" class="btn btn-danger" type="button" :disabled="busy" @click="emit('requestLogout')"><i class="bx bx-log-out" aria-hidden="true"></i>退出 QQ</button>
        <button v-else class="btn btn-primary" type="button" :disabled="busy || snapshot?.phase === 'restarting'" @click="emit('refresh')"><i class="bx bx-refresh" :class="busy ? 'bx-spin' : ''" aria-hidden="true"></i>{{ recoveringLogin ? "恢复中" : snapshot?.phase === "expired" ? "重新获取" : "刷新二维码" }}</button>
      </footer>
    </section>
  </DialogOverlay>
</template>
