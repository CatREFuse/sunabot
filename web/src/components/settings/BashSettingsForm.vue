<script setup lang="ts">
import { computed } from "vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["bash"]>({ required: true });
const keywords = computed({
  get: () => draft.value.blockedKeywords.join(", "),
  set: (value: string) => {
    draft.value.blockedKeywords = value.split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
  }
});
</script>

<template>
  <section class="grid gap-8">
    <div>
      <p class="page-kicker">BASH</p>
      <h2 class="section-title mt-2">命令执行</h2>
      <p class="mt-2 text-sm text-mute">扩大命令权限会增加主机风险，请保留最小访问范围。</p>
    </div>
    <div class="divide-y divide-line rounded-lg border border-line px-4">
      <ToggleSwitch v-model="draft.enabled" label="启用 Bash" />
      <ToggleSwitch v-model="draft.allowGroup" label="允许群聊" description="群成员可触发命令执行" />
      <ToggleSwitch v-model="draft.adminOnly" label="仅管理员" />
      <ToggleSwitch v-model="draft.workspaceOnly" label="仅 Agent Workspace" />
    </div>
    <label class="field">
      <span class="field-label">阻止关键字</span>
      <textarea v-model="keywords" class="control min-h-28" placeholder="rm, sudo"></textarea>
      <small class="text-xs text-mute">使用逗号或换行分隔。</small>
    </label>
  </section>
</template>
