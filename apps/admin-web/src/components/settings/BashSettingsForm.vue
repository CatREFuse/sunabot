<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";

const draft = defineModel<ConfigSectionValueMap["bash"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">命令执行</h2>
      <p class="mt-2 text-sm text-mute">每条 Native Bash 与 Docker Bash 命令均由独立审批 Agent 对抗审核。</p>
    </div>
    <div class="settings-group grid gap-5">
      <h3 class="settings-group-title">命令审批</h3>
      <label class="field">
        <span class="field-label">对抗审批 Agent</span>
        <SettingsConfirmInput v-model="draft.auditModel" type="text" spellcheck="false" confirm-label="确认审批模型" />
      </label>
      <div class="divide-y divide-line border-y border-line">
        <ToggleSwitch v-model="draft.strictMode" label="严格审批" description="外部路径和高风险操作使用更严格的判定" />
      </div>
    </div>
    <div class="settings-group grid gap-5">
      <h3 class="settings-group-title">会话路由</h3>
      <dl class="border-y border-line">
        <div class="divider-row">
          <dt class="field-label">管理员 QQ 私聊</dt>
          <dd class="inline-state"><i class="bx bx-terminal mr-1" aria-hidden="true"></i>Native Bash · Docker Bash</dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">管理 Web Chat</dt>
          <dd class="inline-state"><i class="bx bx-terminal mr-1" aria-hidden="true"></i>Native Bash · Docker Bash</dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">全部群聊与其他 QQ 私聊</dt>
          <dd class="inline-state"><i class="bx bx-cube mr-1" aria-hidden="true"></i>Docker Bash</dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">共享配置</dt>
          <dd class="inline-state"><i class="bx bx-lock-alt mr-1" aria-hidden="true"></i>Skill 与 MCP · 只读</dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">工作目录</dt>
          <dd class="inline-state"><i class="bx bx-folder mr-1" aria-hidden="true"></i>Native：Agent workbench · Docker：隔离 workbench</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
