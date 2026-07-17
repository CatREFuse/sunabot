<script setup lang="ts">
import { computed, reactive, shallowRef } from "vue";
import type { AgentAccount } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";
import OneBotLoginDialog from "../overview/OneBotLoginDialog.vue";
import { useQqLogin } from "../../composables/useQqLogin";
import { apiRequest } from "../../composables/useAdminApi";

const props = defineProps<{ agentId: string; accounts: readonly AgentAccount[]; busy?: boolean }>();
const emit = defineEmits<{
  create: [label: string];
  run: [accountId: string];
  remove: [accountId: string];
  refresh: [];
}>();
const createOpen = shallowRef(false);
const draft = reactive({ label: "" });
const activeAccount = shallowRef<AgentAccount>();
const actionError = shallowRef("");
const accountsWithErrors = computed(() => props.accounts.filter((account) => account.lastError));
const qqLogin = useQqLogin({
  paths: () => {
    const accountId = activeAccount.value?.id ?? "missing";
    const base = `/api/agents/${encodeURIComponent(props.agentId)}/accounts/${encodeURIComponent(accountId)}`;
    return { status: `${base}/login/status`, login: `${base}/login`, logout: `${base}/logout` };
  },
  onOnline: () => emit("refresh")
});

function create() {
  const label = draft.label.trim();
  if (!label) return;
  emit("create", label);
  draft.label = "";
  createOpen.value = false;
}

function openLogin(account: AgentAccount) {
  if (!account.runtimeReady) return;
  activeAccount.value = account;
  void qqLogin.openDialog();
}

async function openNapCat(route: string) {
  actionError.value = "";
  try {
    const result = await apiRequest<{ url: string }>(route);
    window.open(result.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "NapCat 地址不可用";
  }
}

function accountStatus(account: AgentAccount) {
  if (account.connected) return "在线";
  if (account.reconcileRequired) return "需要处理";
  if (account.desiredState === "stopped") return "已停用";
  if (account.observedState === "running" || account.runtimeReady) return "待登录";
  return "未运行";
}
</script>

<template>
  <section class="mt-10 border-t border-line pt-6">
    <div class="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
      <div>
        <span class="meta-label">NapCat Docker</span>
        <h3 class="mt-2 text-xl font-medium text-display">QQ 运行容器</h3>
      </div>
      <button class="btn min-h-10 whitespace-nowrap px-4" type="button" @click="createOpen = true">
        <i class="bx bx-plus text-lg" aria-hidden="true"></i>
        <span>新建 NapCat QQ Docker</span>
      </button>
    </div>

    <div v-if="accounts.length" class="mt-5 border-t border-line">
      <div v-for="account in accounts" :key="account.id" class="flex min-h-20 flex-wrap items-center gap-3 border-b border-line py-3 sm:flex-nowrap sm:gap-4">
        <span class="grid size-10 shrink-0 place-items-center rounded-full bg-raised text-xl text-mute"><i class="bx bxl-qq" aria-hidden="true"></i></span>
        <span class="min-w-0 flex-1">
          <strong class="block truncate font-normal text-display">{{ account.label }}</strong>
          <small class="mt-1 block truncate font-mono text-[10px] text-mute">{{ account.qqId || account.selfId || account.id }}</small>
        </span>
        <span class="font-mono text-[10px] uppercase" :class="account.connected ? 'text-success' : account.reconcileRequired ? 'text-accent' : 'text-mute'">{{ accountStatus(account) }}</span>
        <button v-if="!account.runtimeReady" class="btn min-h-9 px-3" type="button" :disabled="busy" @click="emit('run', account.id)">运行</button>
        <button v-else class="btn min-h-9 px-3" type="button" @click="openLogin(account)">{{ account.connected ? "账号" : "登录" }}</button>
        <button v-if="!account.connected && account.id !== 'primary'" class="icon-btn text-mute hover:text-accent" type="button" :aria-label="`移除 ${account.label}`" :disabled="busy" @click="emit('remove', account.id)">
          <i class="bx bx-trash" aria-hidden="true"></i>
        </button>
      </div>
      <p v-for="account in accountsWithErrors" :key="`${account.id}-error`" class="border-b border-line py-3 text-sm text-accent" role="alert">
        {{ account.label }}：{{ account.lastError }}
      </p>
    </div>
    <p v-if="actionError" class="mt-4 text-sm text-accent" role="alert">{{ actionError }}</p>
    <div v-if="!accounts.length" class="empty-state min-h-48 py-12">
      <div><strong>还没有 QQ 运行容器</strong></div>
    </div>
  </section>

  <DialogOverlay :open="createOpen" labelledby="create-account-title" @close="createOpen = false">
    <form class="w-full max-w-md border border-visible bg-panel p-6" @submit.prevent="create">
      <div class="flex items-center justify-between gap-4">
        <h2 id="create-account-title" class="text-xl font-medium text-display">新建 NapCat QQ Docker</h2>
        <button class="icon-btn" type="button" aria-label="关闭" @click="createOpen = false"><i class="bx bx-x" aria-hidden="true"></i></button>
      </div>
      <label class="field mt-8">
        <span class="field-label">名称</span>
        <input v-model="draft.label" class="control" maxlength="40" required data-dialog-initial-focus placeholder="例如：阿罗娜主账号">
      </label>
      <div class="mt-8 flex justify-end gap-3">
        <button class="btn" type="button" @click="createOpen = false">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy || !draft.label.trim()">新建</button>
      </div>
    </form>
  </DialogOverlay>

  <OneBotLoginDialog
    :open="qqLogin.open.value"
    :account-id="activeAccount?.id ?? ''"
    :account-label="activeAccount?.label ?? ''"
    :busy="qqLogin.busy.value"
    :checking="qqLogin.checking.value"
    :snapshot="qqLogin.snapshot.value"
    :error="qqLogin.error.value"
    :confirming-logout="qqLogin.confirmingLogout.value"
    @close="qqLogin.closeDialog"
    @refresh="qqLogin.refreshQrCode"
    @request-logout="qqLogin.requestLogout"
    @cancel-logout="qqLogin.cancelLogout"
    @logout="qqLogin.logout"
    @webui="openNapCat"
  />
</template>
