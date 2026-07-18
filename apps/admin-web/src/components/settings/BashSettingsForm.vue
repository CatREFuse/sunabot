<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const draft = defineModel<ConfigSectionValueMap["bash"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">命令执行</h2>
      <p class="mt-2 text-sm text-mute">扩大命令权限会增加主机风险，请保留最小访问范围。</p>
    </div>
    <label class="field">
      <span class="field-label">管理员私聊后端</span>
      <select v-model="draft.adminPrivateBackend" class="control">
        <option value="native">Native</option>
        <option value="docker">Docker</option>
      </select>
      <small class="text-xs text-mute">macOS 使用 Docker；Linux 和 WSL 可使用 Native。</small>
    </label>
    <label class="field">
      <span class="field-label">审计模型</span>
      <input v-model="draft.auditModel" class="control" type="text" spellcheck="false">
    </label>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.strictMode" label="严格审计" description="提高独立审计对外部路径和高风险操作的判定强度" />
      <ToggleSwitch v-model="draft.adminOnly" label="管理员身份门禁" description="开启后仅管理员 QQ 会话可使用；关闭将停用 Bash" />
      <ToggleSwitch v-model="draft.allowGroup" label="允许管理员在群聊中使用" description="群聊固定使用 Docker 受限模式" />
    </div>
    <dl class="border-y border-line">
      <div class="divider-row">
        <dt class="field-label">默认目录</dt>
        <dd class="inline-state"><i class="bx bx-folder mr-1" aria-hidden="true"></i>Agent workbench</dd>
      </div>
      <div class="divider-row">
        <dt class="field-label">外部访问</dt>
        <dd class="inline-state"><i class="bx bx-lock-alt mr-1" aria-hidden="true"></i>只读逐次确认</dd>
      </div>
      <div class="divider-row">
        <dt class="field-label">Web Chat</dt>
        <dd class="inline-state"><i class="bx bx-block mr-1" aria-hidden="true"></i>不可用</dd>
      </div>
    </dl>
  </section>
</template>
