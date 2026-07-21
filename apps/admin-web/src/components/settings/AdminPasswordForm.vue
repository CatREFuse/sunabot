<script setup lang="ts">
import { shallowRef } from "vue";
import { useAdminApi } from "../../composables/useAdminApi";

const api = useAdminApi();
const currentPassword = shallowRef("");
const newPassword = shallowRef("");
const confirmPassword = shallowRef("");
const busy = shallowRef(false);
const message = shallowRef("");
const messageKind = shallowRef<"success" | "error" | undefined>();

async function submit() {
  message.value = "";
  messageKind.value = undefined;
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    message.value = "请填写全部密码字段。";
    messageKind.value = "error";
    return;
  }
  if (newPassword.value.length < 12) {
    message.value = "新密码至少需要 12 个字符。";
    messageKind.value = "error";
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    message.value = "两次输入的新密码不一致。";
    messageKind.value = "error";
    return;
  }

  busy.value = true;
  try {
    await api.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      confirmPassword: confirmPassword.value
    });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    message.value = "密码已更新";
    messageKind.value = "success";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "密码修改失败";
    messageKind.value = "error";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="admin-password-title">
    <header class="border-b border-line pb-6">
      <h2 id="admin-password-title" class="section-title">管理员密码</h2>
      <p class="mt-2 text-sm leading-6 text-mute">新密码至少需要 12 个字符，修改后其他管理会话会退出。</p>
    </header>

    <form class="mt-8 grid max-w-xl gap-5" @submit.prevent="submit">
      <label class="field">
        <span class="field-label">当前密码</span>
        <input v-model="currentPassword" class="control" type="password" autocomplete="current-password" maxlength="1024">
      </label>
      <label class="field">
        <span class="field-label">新密码</span>
        <input v-model="newPassword" class="control" type="password" autocomplete="new-password" minlength="12" maxlength="1024">
      </label>
      <label class="field">
        <span class="field-label">确认新密码</span>
        <input v-model="confirmPassword" class="control" type="password" autocomplete="new-password" minlength="12" maxlength="1024">
      </label>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
        <span class="inline-state" :data-kind="messageKind">{{ message }}</span>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          <i class="bx bx-key" aria-hidden="true"></i>{{ busy ? "修改中" : "修改密码" }}
        </button>
      </div>
    </form>
  </section>
</template>
