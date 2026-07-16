<script setup lang="ts">
import type { ConfigDoctorProposal } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";

const props = defineProps<{
  open: boolean;
  proposal: ConfigDoctorProposal | null;
  applying: boolean;
}>();
const emit = defineEmits<{ close: []; confirm: [] }>();

function close() {
  if (!props.applying) emit("close");
}

function actionLabel(action: ConfigDoctorProposal["changes"][number]["action"]) {
  if (action === "add") return "补充";
  if (action === "remove") return "移除";
  return "更新";
}
</script>

<template>
  <DialogOverlay
    :open="open"
    :dismissible="!applying"
    labelledby="config-doctor-repair-title"
    @close="close"
  >
    <section v-if="proposal" class="w-full max-w-xl rounded border border-visible bg-panel p-6">
      <h2 id="config-doctor-repair-title" class="text-xl font-medium text-display">应用这些修复？</h2>
      <p class="mt-3 text-sm leading-6 text-mute">将先备份当前配置，再应用下列修改。</p>

      <div class="mt-6 max-h-[40vh] overflow-y-auto divide-y divide-line border-y border-line">
        <article v-for="(change, index) in proposal.changes" :key="`${change.action}:${change.path}:${index}`" class="py-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <code class="break-all text-xs text-display">{{ change.path }}</code>
            <span class="inline-state" :data-kind="change.risk === 'medium' ? 'warning' : undefined">
              {{ actionLabel(change.action) }} · {{ change.risk === "medium" ? "中风险" : "低风险" }}
            </span>
          </div>
          <p class="mt-2 text-sm leading-6 text-ink">{{ change.summary }}</p>
        </article>
      </div>

      <div class="mt-8 flex flex-wrap justify-end gap-2">
        <button class="btn btn-ghost" type="button" :disabled="applying" @click="close">取消</button>
        <button class="btn btn-primary" type="button" :disabled="applying" @click="emit('confirm')">
          <i class="bx bx-first-aid" aria-hidden="true"></i>{{ applying ? "修复中" : "应用修复" }}
        </button>
      </div>
    </section>
  </DialogOverlay>
</template>
