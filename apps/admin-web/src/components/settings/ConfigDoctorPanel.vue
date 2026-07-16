<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import type {
  ConfigDoctorApplyResult,
  ConfigDoctorChange,
  ConfigDoctorIssue,
  ConfigDoctorReport
} from "../../types";
import { formatFullDateTime } from "../../utils/format";
import ConfigDoctorRepairDialog from "./ConfigDoctorRepairDialog.vue";

const props = defineProps<{
  report: ConfigDoctorReport | null;
  applyResult: ConfigDoctorApplyResult | null;
  scanning: boolean;
  proposing: boolean;
  applying: boolean;
  error: string;
  message: string;
}>();
const emit = defineEmits<{ scan: []; propose: []; apply: [] }>();
const repairOpen = shallowRef(false);

const busy = computed(() => props.scanning || props.proposing || props.applying);
const repairableCount = computed(() => props.report?.issues.filter((issue) => issue.repairable).length ?? 0);
const statusLabel = computed(() => {
  if (props.scanning && !props.report) return "检查中";
  if (!props.report) return "尚未检查";
  if (props.report.status === "healthy") return "配置正常";
  if (props.report.status === "manual") return "需要手动处理";
  return repairableCount.value > 0 ? `发现 ${repairableCount.value} 项可修复问题` : "发现可修复问题";
});
const statusClass = computed(() => {
  if (!props.report) return "text-display";
  if (props.report.status === "healthy") return "text-success";
  return props.report.status === "manual" ? "text-accent" : "text-warning";
});
const aiButtonLabel = computed(() => {
  if (props.proposing) return "AI 诊断中";
  return props.report?.proposal?.source === "ai" ? "重新 AI 诊断" : "AI 诊断";
});

watch(() => props.report?.proposal?.id, (proposalId) => {
  if (!proposalId) repairOpen.value = false;
});
watch(() => props.applying, (applying, previous) => {
  if (previous && !applying) repairOpen.value = false;
});

function issueSourceLabel(source: ConfigDoctorIssue["source"]) {
  if (source === "syntax") return "语法检查";
  if (source === "ai") return "AI 诊断";
  return "本地规则";
}

function proposalSourceLabel(source: NonNullable<ConfigDoctorReport["proposal"]>["source"]) {
  return source === "ai" ? "AI 诊断" : "本地规则";
}

function changeActionLabel(action: ConfigDoctorChange["action"]) {
  if (action === "add") return "补充";
  if (action === "remove") return "移除";
  return "更新";
}

function confirmApply() {
  emit("apply");
}
</script>

<template>
  <section aria-label="配置医生" class="grid gap-10">
    <div class="flex flex-wrap items-center justify-between gap-5 border-y border-visible py-5">
      <div class="flex min-w-0 items-center gap-4">
        <i class="bx bx-first-aid text-[30px] text-display" aria-hidden="true"></i>
        <div class="min-w-0">
          <span class="meta-label">检查状态</span>
          <strong class="mt-1 block text-lg font-medium" :class="statusClass">{{ statusLabel }}</strong>
          <time v-if="report" class="mt-1 block font-mono text-[10px] text-mute" :datetime="report.generatedAt">
            {{ formatFullDateTime(report.generatedAt) }}
          </time>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn" type="button" :disabled="busy" @click="emit('scan')">
          <i class="bx bx-scan" aria-hidden="true"></i>{{ scanning ? "检查中" : report ? "重新检查" : "检查配置" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="inline-state" data-kind="error">{{ error }}</p>
    <p v-else-if="message" class="inline-state" data-kind="success">{{ message }}</p>

    <section v-if="report" aria-labelledby="config-doctor-ai-title">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="config-doctor-ai-title" class="section-title">AI 诊断</h2>
          <p class="mt-2 text-sm leading-6 text-mute">仅发送脱敏后的配置结构，并在本地复核修复方案。</p>
        </div>
        <button
          v-if="report.ai.available"
          class="btn"
          type="button"
          :disabled="busy"
          @click="emit('propose')"
        >
          <i class="bx bx-bot" aria-hidden="true"></i>{{ aiButtonLabel }}
        </button>
        <span v-else class="inline-state" data-kind="warning">
          {{ report.ai.provider ? "当前不可用" : "未配置" }}
        </span>
      </div>

      <dl v-if="report.ai.provider" class="mt-6 grid border-y border-line sm:grid-cols-3">
        <div class="border-b border-line py-4 sm:border-b-0 sm:border-r sm:pr-5">
          <dt class="meta-label">Provider</dt>
          <dd class="mt-2 text-sm text-display">{{ report.ai.provider.label }}</dd>
        </div>
        <div class="border-b border-line py-4 sm:border-b-0 sm:border-r sm:px-5">
          <dt class="meta-label">模型</dt>
          <dd class="mt-2 break-all font-mono text-xs text-display">{{ report.ai.provider.model }}</dd>
        </div>
        <div class="py-4 sm:pl-5">
          <dt class="meta-label">请求目标</dt>
          <dd class="mt-2 break-all font-mono text-xs text-display">{{ report.ai.provider.destination }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="report?.issues.length" aria-labelledby="config-doctor-issues-title">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <h2 id="config-doctor-issues-title" class="section-title">检查结果</h2>
        <span class="font-mono text-[10px] text-mute">{{ report.issues.length }} 项</span>
      </div>
      <div class="mt-5 divide-y divide-line border-y border-line">
        <article v-for="issue in report.issues" :key="issue.id" class="py-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <code class="break-all text-xs text-display">{{ issue.path }}</code>
            <span class="inline-state" :data-kind="issue.severity === 'error' ? 'error' : 'warning'">
              {{ issueSourceLabel(issue.source) }} · {{ issue.repairable ? "可修复" : "需手动处理" }}
            </span>
          </div>
          <p class="mt-2 text-sm leading-6 text-ink">{{ issue.message }}</p>
        </article>
      </div>
    </section>

    <section v-if="report?.proposal" aria-labelledby="config-doctor-proposal-title">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="config-doctor-proposal-title" class="section-title">修复方案</h2>
          <p class="mt-2 text-sm leading-6 text-mute">
            {{ proposalSourceLabel(report.proposal.source) }} · {{ report.proposal.risk === "medium" ? "中风险" : "低风险" }}
          </p>
        </div>
        <button class="btn btn-primary" type="button" :disabled="busy || !report.proposal.changes.length" @click="repairOpen = true">
          <i class="bx bx-first-aid" aria-hidden="true"></i>{{ applying ? "修复中" : "应用修复" }}
        </button>
      </div>

      <div class="mt-5 divide-y divide-line border-y border-line">
        <article v-for="(change, index) in report.proposal.changes" :key="`${change.action}:${change.path}:${index}`" class="py-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <code class="break-all text-xs text-display">{{ change.path }}</code>
            <span class="inline-state" :data-kind="change.risk === 'medium' ? 'warning' : undefined">
              {{ changeActionLabel(change.action) }} · {{ change.risk === "medium" ? "中风险" : "低风险" }}
            </span>
          </div>
          <p class="mt-2 text-sm leading-6 text-ink">{{ change.summary }}</p>
        </article>
      </div>
      <p class="mt-3 font-mono text-[10px] text-mute">方案有效期至 {{ formatFullDateTime(report.proposal.expiresAt) }}</p>
    </section>

    <section v-if="applyResult" aria-labelledby="config-doctor-result-title" class="border-l-2 border-success py-2 pl-5">
      <h2 id="config-doctor-result-title" class="section-title">配置已修复</h2>
      <p class="mt-3 text-sm text-ink">已应用 {{ applyResult.appliedChanges }} 项修改。</p>
      <p v-if="applyResult.restartRequired" class="mt-2 text-sm text-warning">磁盘中还有待加载的配置，请重启服务。</p>
      <p class="mt-2 break-all font-mono text-[10px] text-mute">{{ applyResult.backupPath }}</p>
    </section>
  </section>

  <ConfigDoctorRepairDialog
    :open="repairOpen"
    :proposal="report?.proposal ?? null"
    :applying="applying"
    @close="repairOpen = false"
    @confirm="confirmApply"
  />
</template>
