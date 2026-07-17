<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type { AgentSummary } from "../../types";
import type { AgentSkillRecord, SkillCopyPreview } from "../../types/agentExtensions";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  skill: AgentSkillRecord | null;
  sourceAgentId: string;
  agents: readonly AgentSummary[];
  preview: SkillCopyPreview | null;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  preview: [input: { targetAgentId: string; mcpServerIds: string[] }];
  apply: [input: { targetAgentId: string; mcpServerIds: string[]; conflictStrategy: "skip" | "replace" | "rename"; renameTo?: string }];
}>();
const targetAgentId = shallowRef("");
const includeDependencies = shallowRef(true);
const conflictStrategy = shallowRef<"skip" | "replace" | "rename">("skip");
const renameTo = shallowRef("");
const targets = computed(() => props.agents.filter((agent) => agent.id !== props.sourceAgentId));
const dependencyIds = computed(() => props.skill?.riskEvidence.mcpDependencies.map((item) => item.id) ?? []);
const revisions = computed(() => props.preview ? [
  { label: "Skill 来源", value: props.preview.sourceSkillRevision },
  { label: "Skill 目标", value: props.preview.targetSkillRevision },
  { label: "MCP 来源", value: props.preview.sourceMcpRevision },
  { label: "MCP 目标", value: props.preview.targetMcpRevision },
  { label: "预览", value: props.preview.previewRevision }
] : []);

watch(() => props.skill, (skill) => {
  if (!skill) return;
  targetAgentId.value = targets.value[0]?.id ?? "";
  includeDependencies.value = true;
  conflictStrategy.value = "skip";
  renameTo.value = `${skill.id}-copy`;
}, { immediate: true });

function selectedMcp() {
  return includeDependencies.value ? dependencyIds.value : [];
}

function shortRevision(value: string) {
  return `${value.slice(0, 12)}…`;
}

function conflictLabel(value: "none" | "same-content" | "different-content") {
  return value === "none" ? "无冲突" : value === "same-content" ? "内容相同" : "内容不同";
}

function dependencyStatusLabel(value: SkillCopyPreview["skill"]["declaredMcpDependenciesStatus"]) {
  return value === "none" ? "无依赖" : value === "declared" ? "依赖已满足" : "依赖缺失";
}
</script>

<template>
  <DialogOverlay :open="Boolean(skill)" labelledby="skill-copy-title" @close="emit('close')">
    <form v-if="skill" class="max-h-[calc(100dvh-32px)] w-full max-w-xl overflow-y-auto border border-visible bg-panel p-6 md:p-8" @submit.prevent="preview ? emit('apply', { targetAgentId, mcpServerIds: selectedMcp(), conflictStrategy, ...(conflictStrategy === 'rename' ? { renameTo } : {}) }) : emit('preview', { targetAgentId, mcpServerIds: selectedMcp() })">
      <header class="flex items-start justify-between gap-4">
        <div><p class="meta-label">Atomic Copy</p><h2 id="skill-copy-title" class="mt-2 text-2xl font-medium text-display">迁移 {{ skill.name }}</h2></div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x" aria-hidden="true"></i></button>
      </header>
      <label class="field mt-8">
        <span class="field-label">目标 Agent</span>
        <select v-model="targetAgentId" class="control" required data-dialog-initial-focus :disabled="Boolean(preview)">
          <option v-for="agent in targets" :key="agent.id" :value="agent.id">{{ agent.name }} · {{ agent.id }}</option>
        </select>
      </label>
      <label v-if="dependencyIds.length" class="mt-5 flex min-h-11 items-start gap-3 text-sm text-ink">
        <input v-model="includeDependencies" class="mt-1 size-4 accent-current" type="checkbox" :disabled="Boolean(preview)">
        <span>同时复制 MCP 配置<span class="mt-1 block font-mono text-[10px] text-mute">{{ dependencyIds.join(" · ") }}，凭据不会复制</span></span>
      </label>
      <section v-if="preview" class="mt-6 border-y border-visible py-4">
        <div class="divider-row"><span class="meta-label">冲突</span><strong class="font-normal">{{ conflictLabel(preview.skill.conflict) }}</strong></div>
        <div class="divider-row"><span class="meta-label">文件</span><strong class="font-normal">{{ preview.skill.files.length }}</strong></div>
        <div class="divider-row"><span class="meta-label">安全依赖</span><strong class="font-normal">{{ dependencyStatusLabel(preview.skill.declaredMcpDependenciesStatus) }}</strong></div>
        <div class="divider-row"><span class="meta-label">声明的 MCP</span><strong class="max-w-[65%] text-right font-normal">{{ preview.skill.declaredMcpDependencies.map((item) => item.id).join("、") || "无" }}</strong></div>
        <div class="divider-row"><span class="meta-label">缺少 MCP</span><strong class="max-w-[65%] text-right font-normal">{{ preview.skill.missingMcpDependencies.join("、") || "无" }}</strong></div>

        <section class="mt-5" aria-label="迁移修订">
          <h3 class="meta-label">Revision</h3>
          <dl class="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div v-for="revision in revisions" :key="revision.label" class="flex min-w-0 items-center justify-between gap-3 border-b border-line pb-2">
              <dt class="text-xs text-mute">{{ revision.label }}</dt>
              <dd class="min-w-0 truncate font-mono text-[10px] text-ink" :title="revision.value">{{ shortRevision(revision.value) }}</dd>
            </div>
          </dl>
        </section>

        <section v-if="preview.selectedMcpServers.length" class="mt-6" aria-label="MCP 迁移预览">
          <div class="flex items-center justify-between gap-3"><h3 class="meta-label">MCP 配置</h3><span class="font-mono text-[10px] text-mute">{{ preview.selectedMcpServers.length }} 项</span></div>
          <div class="mt-3 max-h-72 overflow-y-auto border-y border-line">
            <article v-for="item in preview.selectedMcpServers" :key="item.server.id" class="border-b border-line py-4 last:border-b-0">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0"><strong class="block truncate font-normal text-display">{{ item.server.name }}</strong><span class="mt-1 block truncate font-mono text-[10px] text-mute">{{ item.server.id }}</span></div>
                <div class="flex flex-wrap justify-end gap-2"><span class="inline-state">{{ conflictLabel(item.conflict) }}</span><span class="inline-state" data-kind="warning">{{ item.targetState === "disabled" ? "目标已停用" : item.targetState }}</span></div>
              </div>
              <dl class="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div><dt class="meta-label">授权</dt><dd class="mt-1 text-sm text-ink">{{ item.requiresAuthorization ? "需要重新授权" : "无需重新授权" }}</dd></div>
                <div><dt class="meta-label">Descriptor</dt><dd class="mt-1 truncate font-mono text-[10px] text-ink" :title="item.descriptorVersion">{{ shortRevision(item.descriptorVersion) }}</dd></div>
                <div>
                  <dt class="meta-label">源 Agent Secret</dt>
                  <dd class="mt-2 grid gap-1 font-mono text-[10px]">
                    <span v-for="key in item.sourceSecrets.configuredKeys" :key="`source-configured-${key}`" class="break-all text-success">{{ key }} · 已配置</span>
                    <span v-for="key in item.sourceSecrets.missingKeys" :key="`source-missing-${key}`" class="break-all text-warning">{{ key }} · 缺失</span>
                    <span v-if="!item.sourceSecrets.configuredKeys.length && !item.sourceSecrets.missingKeys.length" class="text-mute">无需 Secret</span>
                  </dd>
                </div>
                <div>
                  <dt class="meta-label">目标 Agent Secret</dt>
                  <dd class="mt-2 grid gap-1 font-mono text-[10px]">
                    <span v-for="key in item.targetSecrets.configuredKeys" :key="`target-configured-${key}`" class="break-all text-success">{{ key }} · 已配置</span>
                    <span v-for="key in item.targetSecrets.missingKeys" :key="`target-missing-${key}`" class="break-all text-warning">{{ key }} · 缺失</span>
                    <span v-if="!item.targetSecrets.configuredKeys.length && !item.targetSecrets.missingKeys.length" class="text-mute">无需 Secret</span>
                  </dd>
                </div>
              </dl>
            </article>
          </div>
        </section>

        <label class="field mt-5">
          <span class="field-label">同名处理</span>
          <select v-model="conflictStrategy" class="control"><option value="skip">跳过</option><option value="replace">替换</option><option value="rename">重命名</option></select>
        </label>
        <label v-if="conflictStrategy === 'rename'" class="field mt-4"><span class="field-label">新名称</span><input v-model="renameTo" class="control" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="64" required></label>
      </section>
      <p v-if="error" class="mt-5 text-sm text-accent" role="alert">{{ error }}</p>
      <footer class="mt-8 flex justify-end gap-2">
        <button class="btn" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="busy || !targetAgentId">{{ busy ? "处理中" : preview ? "确认迁移" : "生成预览" }}</button>
      </footer>
    </form>
  </DialogOverlay>
</template>
