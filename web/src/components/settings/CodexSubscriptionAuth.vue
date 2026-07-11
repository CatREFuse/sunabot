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
</script>

<template>
  <section class="rounded-xl border border-visible bg-panel p-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="page-kicker">CHATGPT SUBSCRIPTION</p>
        <h3 class="mt-2 text-lg font-medium text-display">Codex 订阅登录</h3>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-mute">使用官方设备授权登录。令牌只保存在服务器的 workspace/security 中，不会发送到浏览器或 Git。</p>
      </div>
      <span class="inline-state" :data-kind="snapshot?.authenticated ? 'success' : 'warning'">
        {{ snapshot?.authenticated ? "[LOGGED IN]" : snapshot?.installed ? "[NOT LOGGED IN]" : "[CLI MISSING]" }}
      </span>
    </div>

    <div v-if="snapshot?.login.verificationUrl || snapshot?.login.userCode" class="mt-5 grid gap-3 rounded-lg border border-line bg-raised p-4">
      <p v-if="snapshot.login.userCode" class="font-mono text-xl tracking-[0.18em] text-display">{{ snapshot.login.userCode }}</p>
      <a
        v-if="snapshot.login.verificationUrl"
        class="text-sm text-accent underline underline-offset-4"
        :href="snapshot.login.verificationUrl"
        target="_blank"
        rel="noopener noreferrer"
      >打开 OpenAI 设备授权页面</a>
      <p class="text-xs text-mute">{{ snapshot.login.message }}</p>
    </div>

    <p v-if="error" class="mt-4 text-sm text-accent">[ERROR: {{ error }}]</p>
    <div class="mt-5 flex flex-wrap gap-2">
      <button class="btn" type="button" :disabled="busy || !snapshot?.installed" @click="startLogin">重新登录</button>
      <button class="btn btn-ghost" type="button" :disabled="busy || !snapshot?.authenticated" @click="logout">退出订阅</button>
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="refresh">刷新状态</button>
    </div>
  </section>
</template>
