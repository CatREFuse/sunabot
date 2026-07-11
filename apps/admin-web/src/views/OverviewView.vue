<script setup lang="ts">
import { Activity, ExternalLink, RefreshCw, ScanLine, Users } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { apiRequest } from "../composables/useAdminApi";
import { useRuntimeStatus } from "../composables/useRuntimeStatus";
import { formatFullDateTime } from "../utils/format";
import type { ConversationRecord, ImageHistoryRecord, OneBotChatList, OneBotLoginCheck, OneBotLoginInfo, OneBotQrLogin } from "../types";
import PageHeader from "../components/ui/PageHeader.vue";
import DiagnosticsDrawer from "../components/overview/DiagnosticsDrawer.vue";
import OneBotLoginDialog from "../components/overview/OneBotLoginDialog.vue";
import OneBotChatsDrawer from "../components/overview/OneBotChatsDrawer.vue";
import OneBotStatusPanel from "../components/overview/OneBotStatusPanel.vue";

const runtime = useRuntimeStatus();
const loginInfo = shallowRef<OneBotLoginInfo | null>(null);
const qqStatus = shallowRef<OneBotLoginCheck | null>(null);
const chats = shallowRef<OneBotChatList | null>(null);
const conversationCount = shallowRef(0);
const imageCount = shallowRef(0);
const loadingChats = shallowRef(false);
const chatsError = shallowRef("");
const chatsOpen = shallowRef(false);
const loginOpen = shallowRef(false);
const loginBusy = shallowRef(false);
const loginChecking = shallowRef(false);
const loginQr = shallowRef<OneBotQrLogin | null>(null);
const loginCheck = shallowRef<OneBotLoginCheck | null>(null);
const loginError = shallowRef("");
const actionMessage = shallowRef("");
const overviewError = shallowRef("");
const diagnosticsOpen = shallowRef(false);
let loginTimer: number | undefined;

const connected = computed(() => runtime.status.value?.onebot.connected ?? false);
const primaryState = computed(() => runtime.error.value && !runtime.status.value ? "ERROR" : connected.value ? "ONLINE" : "OFFLINE");
const qqIdentity = computed(() => {
  const value = loginInfo.value?.data?.user_id ?? qqStatus.value?.data?.user_id ?? runtime.status.value?.onebot.selfIds.join(", ");
  return value || "--";
});
const qqNickname = computed(() => loginInfo.value?.data?.nickname ?? qqStatus.value?.data?.nickname ?? "--");
const qqState = computed<"online" | "offline" | "unknown">(() => {
  if (!connected.value) return "offline";
  if (qqStatus.value?.error) return "unknown";
  if (!qqStatus.value) return "unknown";
  return qqStatus.value.online && Boolean(qqStatus.value.data?.user_id) ? "online" : "offline";
});
const headerMessage = computed(() => {
  if (actionMessage.value === "[REFRESHING...]") return actionMessage.value;
  if (runtime.error.value) return `[ERROR: ${runtime.error.value}]`;
  if (overviewError.value) return `[ERROR: ${overviewError.value}]`;
  return actionMessage.value;
});
const headerMessageKind = computed(() => headerMessage.value.startsWith("[ERROR") ? "error" : headerMessage.value === "[UPDATED]" ? "success" : undefined);

onMounted(() => {
  void loadOverviewDetails();
});
onBeforeUnmount(stopLoginPolling);

async function loadOverviewDetails() {
  const results = await Promise.allSettled([
    apiRequest<OneBotLoginCheck>("/api/onebot/qq-login/status"),
    apiRequest<OneBotLoginInfo>("/api/onebot/login-info"),
    apiRequest<{ conversations: ConversationRecord[] }>("/api/conversations"),
    apiRequest<{ images: ImageHistoryRecord[] }>("/api/images")
  ]);
  if (results[0].status === "fulfilled") qqStatus.value = results[0].value;
  if (results[1].status === "fulfilled") loginInfo.value = results[1].value;
  if (results[2].status === "fulfilled") conversationCount.value = results[2].value.conversations.length;
  if (results[3].status === "fulfilled") imageCount.value = results[3].value.images.length;
  const names = ["QQ 状态", "QQ 身份", "会话", "图像"];
  overviewError.value = results.flatMap((result, index) => result.status === "rejected"
    ? [`${names[index]}: ${result.reason instanceof Error ? result.reason.message : "读取失败"}`]
    : []).join(" · ");
}

async function refreshAll() {
  actionMessage.value = "[REFRESHING...]";
  await Promise.all([runtime.refresh(), loadOverviewDetails()]);
  actionMessage.value = runtime.error.value || overviewError.value ? "" : "[UPDATED]";
}

async function loadChats() {
  loadingChats.value = true;
  chatsError.value = "";
  try {
    chats.value = await apiRequest<OneBotChatList>("/api/onebot/chats");
  } catch (error) {
    chatsError.value = error instanceof Error ? error.message : "联系人读取失败";
  } finally {
    loadingChats.value = false;
  }
}

function openChats() {
  chatsOpen.value = true;
  if (!chats.value) void loadChats();
}

async function startLogin() {
  loginOpen.value = true;
  loginBusy.value = true;
  loginError.value = "";
  stopLoginPolling();
  try {
    loginQr.value = await apiRequest<OneBotQrLogin>("/api/onebot/qq-login", { method: "POST", body: JSON.stringify({}) });
    loginCheck.value = loginQr.value;
    loginError.value = loginQr.value.error ?? "";
    loginTimer = window.setInterval(() => void pollLogin(), 3_000);
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "登录启动失败";
  } finally {
    loginBusy.value = false;
  }
}

async function pollLogin() {
  if (!loginOpen.value || loginChecking.value) return;
  loginChecking.value = true;
  try {
    loginCheck.value = await apiRequest<OneBotLoginCheck>("/api/onebot/qq-login/status");
    if (loginCheck.value.online) {
      stopLoginPolling();
      await refreshAll();
      await loadChats();
    } else loginError.value = loginCheck.value.error ?? "";
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "登录状态读取失败";
  } finally {
    loginChecking.value = false;
  }
}

function stopLoginPolling() {
  if (loginTimer) window.clearInterval(loginTimer);
  loginTimer = undefined;
}

function closeLogin() {
  loginOpen.value = false;
  stopLoginPolling();
}

async function openNapCat(route = "/api/onebot/napcat-webui-url") {
  try {
    if (/^https?:\/\//i.test(route)) {
      window.open(route, "_blank", "noopener,noreferrer");
      return;
    }
    const result = await apiRequest<{ url: string }>(route);
    window.open(result.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    actionMessage.value = `[ERROR: ${error instanceof Error ? error.message : "NapCat 地址不可用"}]`;
  }
}
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader kicker="OVERVIEW" title="运行状态">
        <template #actions>
          <span class="inline-state" :data-kind="headerMessageKind">{{ headerMessage }}</span>
          <button class="icon-btn" type="button" :disabled="runtime.loading.value" aria-label="刷新" @click="refreshAll"><RefreshCw :size="18" :stroke-width="1.5" /></button>
        </template>
      </PageHeader>

      <OneBotStatusPanel
        :primary-state="primaryState"
        :connected="connected"
        :qq-state="qqState"
        :qq="qqIdentity"
        :nickname="qqNickname"
        :connections="runtime.status.value?.onebot.connections ?? 0"
        :connected-at="runtime.status.value?.onebot.connectedAt"
        :last-event-at="runtime.status.value?.onebot.lastEventAt"
        :last-message-event-at="runtime.status.value?.onebot.lastMessageEventAt"
        :refreshing="runtime.loading.value || actionMessage === '[REFRESHING...]'"
        @refresh="refreshAll"
      />

      <div class="mb-10 flex flex-wrap gap-2">
        <button class="btn btn-primary" type="button" @click="startLogin"><ScanLine :size="16" :stroke-width="1.5" />QQ 登录</button>
        <button class="btn" type="button" @click="openChats"><Users :size="16" :stroke-width="1.5" />联系人</button>
        <button class="btn btn-ghost" type="button" @click="openNapCat()"><ExternalLink :size="16" :stroke-width="1.5" />NapCat</button>
        <button class="btn btn-ghost" type="button" @click="diagnosticsOpen = true"><Activity :size="16" :stroke-width="1.5" />诊断</button>
      </div>

      <section class="grid border-y border-line sm:grid-cols-3">
        <div class="border-b border-line py-6 sm:border-b-0 sm:border-r sm:px-6 sm:first:pl-0"><span class="meta-label">记忆</span><strong class="mt-2 block font-mono text-3xl font-normal text-display">{{ runtime.status.value?.persona.memoryItems ?? 0 }}</strong></div>
        <div class="border-b border-line py-6 sm:border-b-0 sm:border-r sm:px-6"><span class="meta-label">会话</span><strong class="mt-2 block font-mono text-3xl font-normal text-display">{{ conversationCount }}</strong></div>
        <div class="py-6 sm:px-6"><span class="meta-label">图像</span><strong class="mt-2 block font-mono text-3xl font-normal text-display">{{ imageCount }}</strong></div>
      </section>

      <section class="mt-10 grid gap-4 lg:grid-cols-2">
        <div class="divider-row"><span class="meta-label">Provider</span><span class="min-w-0 truncate font-mono text-xs text-display">{{ runtime.status.value?.provider.defaultProviderId ?? "--" }}</span></div>
        <div class="divider-row"><span class="meta-label">模型</span><span class="min-w-0 truncate font-mono text-xs text-display">{{ runtime.status.value?.provider.model ?? "--" }}</span></div>
        <div class="divider-row"><span class="meta-label">API Key</span><span class="font-mono text-xs" :class="runtime.status.value?.provider.apiKeyConfigured ? 'text-success' : 'text-warning'">{{ runtime.status.value?.provider.apiKeyConfigured ? "READY" : "MISSING" }}</span></div>
        <div class="divider-row"><span class="meta-label">Agent</span><span class="font-mono text-xs text-display">{{ runtime.status.value?.persona.name ?? "--" }} · {{ runtime.status.value?.persona.id ?? "--" }}</span></div>
        <div class="divider-row"><span class="meta-label">启动时间</span><span class="font-mono text-xs text-display">{{ formatFullDateTime(runtime.status.value?.startedAt) }}</span></div>
        <div class="divider-row"><span class="meta-label">最近消息</span><span class="font-mono text-xs text-display">{{ formatFullDateTime(runtime.status.value?.onebot.lastMessageEventAt) }}</span></div>
        <div class="divider-row"><span class="meta-label">配置文件</span><span class="min-w-0 truncate font-mono text-xs text-display">{{ runtime.status.value?.configPath ?? "--" }}</span></div>
      </section>

      <section v-if="runtime.status.value?.recovery?.required" class="mt-10 rounded-xl border border-accent p-5">
        <p class="inline-state" data-kind="error">[CONFIG RECOVERY REQUIRED]</p>
        <p class="mt-3 text-sm text-ink">{{ runtime.status.value.recovery.message }}</p>
        <p class="mt-2 break-all font-mono text-[10px] text-mute">{{ runtime.status.value.recovery.backupPath }}</p>
      </section>
    </div>

    <OneBotLoginDialog :open="loginOpen" :busy="loginBusy" :checking="loginChecking" :qr="loginQr" :check="loginCheck" :error="loginError" @close="closeLogin" @refresh="startLogin" @webui="openNapCat" />
    <OneBotChatsDrawer :open="chatsOpen" :chats="chats" :loading="loadingChats" :error="chatsError" @close="chatsOpen = false" @refresh="loadChats" />
    <DiagnosticsDrawer :open="diagnosticsOpen" @close="diagnosticsOpen = false" />
  </div>
</template>
