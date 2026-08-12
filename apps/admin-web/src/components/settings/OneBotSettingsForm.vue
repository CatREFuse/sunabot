<script setup lang="ts">
import { computed } from "vue";
import type { ConfigEnvelope, ConfigSectionValueMap } from "../../types";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";
const draft = defineModel<ConfigSectionValueMap["onebot"]>({ required: true });
const props = withDefaults(defineProps<{ fieldStates?: ConfigEnvelope["fieldStates"]; nested?: boolean }>(), { nested: false });
const tokenConfigured = computed(() => props.fieldStates?.["onebot.accessTokenEnv"]?.secretConfigured);
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h3 class="settings-group-title">OneBot 连接</h3>
      <p class="settings-group-description">反向 WebSocket 路径与访问凭据。</p>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">反向 WebSocket 路径</span>
        <SettingsConfirmInput v-model.trim="draft.reverseWsPath" type="text" confirm-label="确认反向 WebSocket 路径" />
        <small class="font-mono text-[10px] text-warning">保存后重启</small>
      </label>
      <label class="field">
        <span class="field-label">Access Token 环境变量</span>
        <SettingsConfirmInput v-model.trim="draft.accessTokenEnv" type="text" confirm-label="确认 Access Token 环境变量" />
        <span class="flex flex-wrap gap-3 font-mono text-[10px]">
          <small class="text-mute">保存后重新连接</small>
          <small v-if="tokenConfigured != null" :class="tokenConfigured ? 'text-success' : 'text-warning'">{{ tokenConfigured ? "已配置" : "未配置" }}</small>
        </span>
      </label>
    </div>
  </section>
</template>
