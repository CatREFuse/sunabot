<script setup lang="ts">
import { shallowRef } from "vue";
import { useAdminApi } from "../../composables/useAdminApi";
import DialogOverlay from "../ui/DialogOverlay.vue";
import LoginHero from "./LoginHero.vue";

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
  <DialogOverlay :open="true" class="!place-items-start !bg-page overflow-y-auto md:!place-items-center" :dismissible="false" :z-index="100" labelledby="login-title">
    <div class="grid w-full max-w-6xl overflow-hidden md:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
      <LoginHero />
      <form class="flex flex-col justify-center border-t border-visible px-6 py-8 md:min-h-[520px] md:border-l md:border-t-0 md:px-10 lg:px-12" @submit.prevent="unlock">
        <i class="bx bx-key text-[40px] text-display" aria-hidden="true"></i>
        <h2 id="login-title" class="mt-8 font-sans text-[36px] font-medium leading-none tracking-[-0.03em] text-display md:text-[48px]">管理员登录</h2>
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
          <button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? "登录中" : "登录" }}</button>
        </div>
      </form>
    </div>
  </DialogOverlay>
</template>
