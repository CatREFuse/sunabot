<script setup lang="ts">
import type { AgentSkillRecord } from "../../types/agentExtensions";
import DialogOverlay from "../ui/DialogOverlay.vue";

defineProps<{ skill: AgentSkillRecord | null; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; approve: [skill: AgentSkillRecord] }>();
</script>

<template>
  <DialogOverlay :open="Boolean(skill)" labelledby="skill-review-title" @close="emit('close')">
    <section v-if="skill" class="max-h-[calc(100dvh-32px)] w-full max-w-2xl overflow-y-auto border border-visible bg-panel p-6 md:p-8">
      <header class="flex items-start justify-between gap-4 border-b border-line pb-6">
        <div class="min-w-0"><p class="meta-label">Skill Review</p><h2 id="skill-review-title" class="mt-2 truncate text-2xl font-medium text-display">{{ skill.name }}</h2><p class="mt-3 text-sm leading-6 text-mute">{{ skill.description }}</p></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <dl class="divide-y divide-line border-b border-line">
        <div class="divider-row"><dt class="meta-label">类型</dt><dd>{{ skill.riskEvidence.classification === "script-bearing" ? "含脚本" : "仅指令" }}</dd></div>
        <div class="divider-row"><dt class="meta-label">外部链接</dt><dd>{{ skill.riskEvidence.hasExternalUrls ? "有" : "无" }}</dd></div>
        <div class="divider-row"><dt class="meta-label">文件权限</dt><dd class="font-mono text-xs">{{ skill.riskEvidence.declaredFileAccess.join(" / ") || "无" }}</dd></div>
        <div class="divider-row"><dt class="meta-label">MCP 依赖</dt><dd class="text-right">{{ skill.riskEvidence.mcpDependencies.map((item) => item.id).join("、") || "无" }}</dd></div>
        <div class="divider-row"><dt class="meta-label">隐式调用</dt><dd>{{ skill.riskEvidence.allowImplicitInvocation === false ? "关闭" : skill.riskEvidence.allowImplicitInvocation === true ? "允许" : "未声明" }}</dd></div>
        <div class="divider-row"><dt class="meta-label">摘要</dt><dd class="max-w-[65%] break-all font-mono text-[10px]">{{ skill.digestSha256 }}</dd></div>
      </dl>
      <p v-if="error" class="mt-5 text-sm text-accent" role="alert">{{ error }}</p>
      <footer class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn" type="button" @click="emit('close')">关闭</button>
        <button v-if="skill.approval?.status !== 'approved' || skill.riskEvidence.reviewStatus !== 'approved'" class="btn btn-primary" type="button" :disabled="busy" @click="emit('approve', skill)">{{ busy ? "审核中" : "确认批准" }}</button>
      </footer>
    </section>
  </DialogOverlay>
</template>
