<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from "vue";
import { apiRequest } from "../../composables/useAdminApi";

interface CodexAuthSnapshot {
  installed: boolean;
  authenticated: boolean;
  method?: string;
  expiresAt?: string;
  login: {
    state: "idle" | "starting" | "waiting" | "succeeded" | "failed";
    verificationUrl?: string;
    userCode?: string;
    message?: string;
  };
}

const snapshot = shallowRef<CodexAuthSnapshot>();
const busy = shallowRef(false);
const error = shallowRef("");
const copied = shallowRef(false);
let pollTimer: number | undefined;

onMounted(() => void refresh());
onBeforeUnmount(stopPolling);

async function refresh() {
  try {
    snapshot.value = await apiRequest<CodexAuthSnapshot>("/api/codex-auth/status");
    error.value = "";
    if (snapshot.value.login.state === "waiting" || snapshot.value.login.state === "starting") startPolling();
    else stopPolling();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "读取订阅登录状态失败";
  }
}

async function startLogin() {
  busy.value = true;
  try {
    snapshot.value = await apiRequest<CodexAuthSnapshot>("/api/codex-auth/login", { method: "POST" });
    error.value = "";
    startPolling();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "启动订阅登录失败";
  } finally {
    busy.value = false;
  }
}

async function logout() {
  busy.value = true;
  try {
    snapshot.value = await apiRequest<CodexAuthSnapshot>("/api/codex-auth/logout", { method: "POST" });
    error.value = "";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "退出订阅登录失败";
  } finally {
    busy.value = false;
  }
}

function startPolling() {
  if (pollTimer != null) return;
  pollTimer = window.setInterval(() => void refresh(), 3_000);
}

function stopPolling() {
  if (pollTimer == null) return;
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function copyCode() {
  const code = snapshot.value?.login.userCode;
  if (!code) return;
  await navigator.clipboard.writeText(code);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1_500);
}
</script>

<template>
  <section class="border-y border-visible bg-raised px-4 py-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h3 class="text-lg font-medium text-display">Codex 订阅登录</h3>
      </div>
      <span class="inline-state" :data-kind="snapshot?.authenticated ? 'success' : 'warning'">
        {{ snapshot?.authenticated ? "已登录" : snapshot?.installed ? "未登录" : "Codex 未安装" }}
      </span>
    </div>

    <div v-if="snapshot?.login.verificationUrl || snapshot?.login.userCode" class="mt-5 grid gap-3 border-l-2 border-display bg-panel p-4">
      <div v-if="snapshot.login.userCode" class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span class="meta-label">授权码</span>
          <p class="mt-1 font-mono text-2xl tracking-[0.18em] text-display">{{ snapshot.login.userCode }}</p>
        </div>
        <button class="btn btn-ghost" type="button" @click="copyCode"><i class="bx bx-copy" aria-hidden="true"></i>{{ copied ? "已复制" : "复制授权码" }}</button>
      </div>
      <a
        v-if="snapshot.login.verificationUrl"
        class="text-sm text-accent underline underline-offset-4"
        :href="snapshot.login.verificationUrl"
        target="_blank"
        rel="noopener noreferrer"
      >打开 OpenAI 设备授权页面</a>
      <p class="text-xs text-mute">{{ snapshot.login.message }}</p>
    </div>

    <p v-if="error" class="mt-4 text-sm text-accent">{{ error }}</p>
    <div class="mt-5 flex flex-wrap gap-2">
      <button class="btn" type="button" :disabled="busy || !snapshot?.installed" @click="startLogin"><i class="bx bx-log-in-circle" aria-hidden="true"></i>{{ snapshot?.authenticated ? "重新登录" : "开始登录" }}</button>
      <button class="btn btn-ghost" type="button" :disabled="busy || !snapshot?.authenticated" @click="logout">退出订阅</button>
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="refresh">刷新状态</button>
    </div>
  </section>
</template>
