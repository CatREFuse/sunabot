<script setup lang="ts">
import type { AgentSkillRecord } from "../../types/agentExtensions";

defineProps<{ skills: readonly AgentSkillRecord[]; busy: boolean }>();
const emit = defineEmits<{
  review: [skill: AgentSkillRecord];
  toggle: [skill: AgentSkillRecord];
  copy: [skill: AgentSkillRecord];
  remove: [skill: AgentSkillRecord];
}>();

function approvalLabel(skill: AgentSkillRecord) {
  return skill.approval?.status === "approved" && skill.riskEvidence.reviewStatus === "approved"
    ? "已审核"
    : "待审核";
}
</script>

<template>
  <section aria-labelledby="skill-list-title">
    <header class="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-visible">
      <div>
        <p class="meta-label">Agent Skills</p>
        <h2 id="skill-list-title" class="mt-2 text-2xl font-medium text-display">Skill</h2>
      </div>
      <slot name="actions" />
    </header>

    <article v-for="skill in skills" :key="skill.id" class="grid gap-5 border-b border-line py-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h3 class="truncate text-lg font-medium text-display">{{ skill.name }}</h3>
          <span class="inline-state" :data-kind="skill.enabled ? 'success' : undefined">{{ skill.enabled ? "已启用" : "已停用" }}</span>
          <span class="inline-state" :data-kind="approvalLabel(skill) === '待审核' ? 'warning' : undefined">{{ approvalLabel(skill) }}</span>
        </div>
        <p class="mt-3 max-w-3xl text-sm leading-6 text-mute">{{ skill.description }}</p>
        <dl class="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.04em] text-mute">
          <div><dt class="inline">风险 </dt><dd class="inline text-ink">{{ skill.riskEvidence.classification === "script-bearing" ? "含脚本" : "仅指令" }}</dd></div>
          <div><dt class="inline">文件 </dt><dd class="inline text-ink">{{ skill.fileCount }}</dd></div>
          <div><dt class="inline">大小 </dt><dd class="inline text-ink">{{ Math.ceil(skill.unpackedBytes / 1024) }} KiB</dd></div>
          <div><dt class="inline">摘要 </dt><dd class="inline text-ink">{{ skill.digestSha256.slice(0, 10) }}</dd></div>
        </dl>
      </div>
      <div class="flex flex-wrap items-center gap-2 lg:justify-end">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('review', skill)">{{ approvalLabel(skill) === "待审核" ? "审核" : "详情" }}</button>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('copy', skill)">迁移</button>
        <button class="btn" type="button" :disabled="busy || approvalLabel(skill) === '待审核'" @click="emit('toggle', skill)">{{ skill.enabled ? "停用" : "启用" }}</button>
        <button class="icon-btn text-accent" type="button" :disabled="busy" :aria-label="`卸载 ${skill.name}`" @click="emit('remove', skill)"><i class="bx bx-trash" aria-hidden="true"></i></button>
      </div>
    </article>

    <div v-if="!skills.length" class="empty-state">
      <div><strong>没有 Skill</strong><p>安装 ZIP 或从其他 Agent 迁移</p></div>
    </div>
  </section>
</template>
