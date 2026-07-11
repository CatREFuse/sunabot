<script setup lang="ts">
import { KeyRound, ShieldAlert } from "lucide-vue-next";
import { shallowRef } from "vue";
import { useAdminApi } from "../../composables/useAdminApi";
import DialogOverlay from "../ui/DialogOverlay.vue";

const api = useAdminApi();
const username = shallowRef("");
const password = shallowRef("");
const busy = shallowRef(false);
const message = shallowRef("");

async function unlock() {
  if (!username.value.trim() || !password.value) {
    message.value = "请输入管理员账号和密码。";
    return;
  }
  busy.value = true;
  message.value = "";
  try {
    await api.login(username.value, password.value);
    password.value = "";
    window.location.reload();
  } catch (error) {
    message.value = error instanceof Error ? error.message : "登录失败";
    password.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DialogOverlay :open="true" class="!bg-page" :dismissible="false" :z-index="100" labelledby="login-title">
    <form class="w-full max-w-md rounded-2xl border border-visible bg-panel p-6 md:p-8" @submit.prevent="unlock">
      <div class="flex items-center justify-between">
        <KeyRound :size="28" :stroke-width="1.5" class="text-display" aria-hidden="true" />
        <span class="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-mute">
          <ShieldAlert :size="14" /> Secure session
        </span>
      </div>
      <p class="page-kicker mt-8">ADMIN ACCESS</p>
      <h1 id="login-title" class="mt-2 text-3xl font-medium text-display">管理员登录</h1>
      <p class="mt-3 text-sm leading-6 text-mute">账号密码仅用于建立受保护的 HttpOnly 会话，不会保存在浏览器存储中。</p>
      <label class="field mt-8">
        <span class="field-label">管理员账号</span>
        <input v-model="username" class="control" type="text" autocomplete="username" maxlength="128" data-dialog-initial-focus>
      </label>
      <label class="field mt-4">
        <span class="field-label">管理员密码</span>
        <input v-model="password" class="control" type="password" autocomplete="current-password" maxlength="1024">
      </label>
      <div class="mt-6 flex items-center justify-between gap-4">
        <span class="inline-state" :data-kind="message ? 'error' : undefined">{{ message }}</span>
        <button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? "验证中" : "登录" }}</button>
      </div>
    </form>
  </DialogOverlay>
</template>
