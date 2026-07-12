<script setup lang="ts">
import { computed } from "vue";
import type { ConfigEnvelope, ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["onebot"]>({ required: true });
const props = defineProps<{ fieldStates?: ConfigEnvelope["fieldStates"] }>();
const tokenConfigured = computed(() => props.fieldStates?.["onebot.accessTokenEnv"]?.secretConfigured);
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">OneBot</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">反向 WebSocket 路径</span>
        <input v-model.trim="draft.reverseWsPath" class="control" type="text">
        <small class="font-mono text-[10px] text-warning">保存后重启</small>
      </label>
      <label class="field">
        <span class="field-label">Access Token 环境变量</span>
        <input v-model.trim="draft.accessTokenEnv" class="control" type="text">
        <span class="flex flex-wrap gap-3 font-mono text-[10px]">
          <small class="text-mute">保存后重新连接</small>
          <small v-if="tokenConfigured != null" :class="tokenConfigured ? 'text-success' : 'text-warning'">{{ tokenConfigured ? "已配置" : "未配置" }}</small>
        </span>
      </label>
    </div>
  </section>
</template>
