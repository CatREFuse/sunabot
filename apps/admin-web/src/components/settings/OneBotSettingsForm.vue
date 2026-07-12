<script setup lang="ts">
import { computed } from "vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigEnvelope, ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["onebot"]>({ required: true });
const props = defineProps<{ fieldStates?: ConfigEnvelope["fieldStates"] }>();
const tokenConfigured = computed(() => props.fieldStates?.["onebot.accessTokenEnv"]?.secretConfigured);
const names = computed({
  get: () => draft.value.mentionNames.join(", "),
  set: (value: string) => (draft.value.mentionNames = split(value))
});
const prefixes = computed({
  get: () => draft.value.commandPrefixes.join(", "),
  set: (value: string) => (draft.value.commandPrefixes = split(value))
});
function split(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
</script>

<template>
  <section class="grid gap-8">
    <div>
      <p class="page-kicker">ONEBOT</p>
      <h2 class="section-title mt-2">OneBot</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">反向 WS Path</span>
        <input v-model.trim="draft.reverseWsPath" class="control" type="text">
        <small class="font-mono text-[10px] text-warning">[RESTART]</small>
      </label>
      <label class="field">
        <span class="field-label">Access Token Env</span>
        <input v-model.trim="draft.accessTokenEnv" class="control" type="text">
        <span class="flex flex-wrap gap-3 font-mono text-[10px]">
          <small class="text-mute">[RECONNECT]</small>
          <small v-if="tokenConfigured != null" :class="tokenConfigured ? 'text-success' : 'text-warning'">{{ tokenConfigured ? "[CONFIGURED]" : "[MISSING]" }}</small>
        </span>
      </label>
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.autoReplyPrivate" label="启用私聊" />
      <ToggleSwitch v-model="draft.autoReplyBotGroup" label="启用 Bot 群聊" />
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">名称</span>
        <input v-model="names" class="control" type="text" placeholder="普拉娜, Plana">
      </label>
      <label class="field">
        <span class="field-label">命令前缀</span>
        <input v-model="prefixes" class="control" type="text" placeholder="/, !">
      </label>
    </div>
  </section>
</template>
