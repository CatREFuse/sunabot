<script setup lang="ts">
import { computed } from "vue";
import type { SunaTool } from "../../types";
import { toolExecutionLabel, toolIcon, toolParameterRows } from "../../utils/toolCatalog";
import DialogOverlay from "../ui/DialogOverlay.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

const props = defineProps<{
  open: boolean;
  tool: SunaTool | null;
  enabled: boolean;
  description: string;
  descriptionOverridden: boolean;
  pokeOnNoReply: boolean;
}>();
const emit = defineEmits<{
  close: [];
  "update:pokeOnNoReply": [enabled: boolean];
  updateDescription: [description: string];
  resetDescription: [];
}>();
const parameters = computed(() => toolParameterRows(props.tool?.parameters));
const descriptionLength = computed(() => props.description.length);
const descriptionSourceLabel = computed(() => {
  if (props.descriptionOverridden) return "全局设置";
  if (props.tool?.descriptionSource === "prompt" || props.tool?.promptDescription != null) return "提示词";
  return "默认";
});
</script>

<template>
  <DialogOverlay :open="open" labelledby="tool-detail-title" @close="emit('close')">
    <section v-if="tool" class="max-h-[calc(100dvh-32px)] w-full max-w-2xl overflow-y-auto rounded border border-visible bg-panel p-5 sm:p-6">
      <header class="flex min-w-0 items-start justify-between gap-4 border-b border-line pb-5">
        <div class="flex min-w-0 items-start gap-3">
          <i class="bx w-11 shrink-0 text-[32px] leading-[44px] text-[rgb(var(--color-interactive))]" :class="toolIcon(tool.name)" aria-hidden="true"></i>
          <div class="min-w-0">
            <h2 id="tool-detail-title" class="text-xl font-medium text-display">{{ tool.title }}</h2>
            <p class="mt-1 break-all font-mono text-[10px] text-disabled">{{ tool.name }}</p>
          </div>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭工具详情" @click="emit('close')">
          <i class="bx bx-x text-2xl" aria-hidden="true"></i>
        </button>
      </header>

      <dl class="grid border-b border-line py-2 sm:grid-cols-2">
        <div class="divider-row sm:mr-5">
          <dt class="field-label">调用方式</dt>
          <dd class="inline-state"><i class="bx bx-transfer-alt mr-1" aria-hidden="true"></i>{{ toolExecutionLabel(tool.execution) }}</dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">参数校验</dt>
          <dd class="inline-state"><i class="bx mr-1" :class="tool.strict ? 'bx-check-shield text-success' : 'bx-shield text-mute'" aria-hidden="true"></i>{{ tool.strict ? "严格" : "常规" }}</dd>
        </div>
        <div class="divider-row sm:mr-5">
          <dt class="field-label">目录配置</dt>
          <dd class="inline-state" :data-kind="enabled ? 'success' : undefined">
            <i class="bx mr-1" :class="enabled ? 'bx-check-circle' : 'bx-pause-circle'" aria-hidden="true"></i>{{ enabled ? "已启用" : "已停用" }}
          </dd>
        </div>
        <div class="divider-row">
          <dt class="field-label">说明来源</dt>
          <dd class="inline-state">{{ descriptionSourceLabel }}</dd>
        </div>
        <div v-if="tool.available === false" class="divider-row sm:col-span-2">
          <dt class="field-label">能力异常</dt>
          <dd class="inline-state text-accent" data-kind="error">
            <i class="bx bx-error-circle mr-1" aria-hidden="true"></i>{{ tool.availabilityReason || tool.unavailableReason || "当前工具运行异常。" }}
          </dd>
        </div>
      </dl>

      <div v-if="tool.name === 'no_reply'" class="border-b border-line py-3">
        <ToggleSwitch
          :model-value="pokeOnNoReply"
          label="no_reply 时戳一戳"
          description="Agent 结束本轮时戳一戳对方"
          @update:model-value="emit('update:pokeOnNoReply', $event)"
        />
      </div>

      <label class="field mt-6">
        <span class="flex items-center justify-between gap-3">
          <span class="field-label">模型描述</span>
          <span class="font-mono text-[10px] text-disabled">{{ descriptionLength }} / 4000</span>
        </span>
        <textarea
          class="control min-h-40 py-3 text-sm leading-6"
          :value="description"
          maxlength="4000"
          spellcheck="false"
          @input="emit('updateDescription', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span v-if="descriptionOverridden" class="inline-state text-[rgb(var(--color-interactive))]"><i class="bx bx-edit-alt mr-1" aria-hidden="true"></i>自定义说明</span>
        <span v-else class="inline-state"><i class="bx bx-reset mr-1" aria-hidden="true"></i>继承说明</span>
        <button class="btn btn-ghost" type="button" :disabled="!descriptionOverridden" @click="emit('resetDescription')">
          <i class="bx bx-reset" aria-hidden="true"></i>恢复继承说明
        </button>
      </div>

      <section class="mt-8" aria-labelledby="tool-parameters-title">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="tool-parameters-title" class="text-lg font-medium text-display">参数</h3>
          </div>
          <span class="inline-state">{{ parameters.length }} 项</span>
        </div>

        <div v-if="parameters.length" class="mt-4 overflow-x-auto border-y border-line">
          <table class="min-w-[560px] w-full text-left text-xs" aria-label="工具参数">
            <thead class="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
              <tr>
                <th class="px-2 py-3 font-normal">参数</th>
                <th class="px-2 py-3 font-normal">类型</th>
                <th class="px-2 py-3 font-normal">要求</th>
                <th class="px-2 py-3 font-normal">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="parameter in parameters" :key="parameter.name" class="border-t border-line align-top">
                <td class="px-2 py-3 font-mono text-display">{{ parameter.name }}</td>
                <td class="max-w-48 break-words px-2 py-3 font-mono text-mute">{{ parameter.type }}</td>
                <td class="px-2 py-3"><span class="inline-state" :data-kind="parameter.required ? 'warning' : undefined">{{ parameter.required ? "必填" : "可选" }}</span></td>
                <td class="min-w-48 px-2 py-3 leading-5 text-mute">{{ parameter.description || "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="mt-4 border-y border-line py-6 text-center font-mono text-xs text-mute">无参数</p>
      </section>
    </section>
  </DialogOverlay>
</template>
