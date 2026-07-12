<script setup lang="ts">
import { computed } from "vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["bot"]>({ required: true });
const reply = defineModel<ConfigSectionValueMap["onebot"]>("reply", { required: true });
const names = computed({
  get: () => reply.value.mentionNames.join(", "),
  set: (value: string) => (reply.value.mentionNames = split(value))
});
const prefixes = computed({
  get: () => reply.value.commandPrefixes.join(", "),
  set: (value: string) => (reply.value.commandPrefixes = split(value))
});
function split(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
</script>

<template>
  <section class="grid gap-8">
    <div>
      <h2 class="section-title">回复行为</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">管理员 QQ</span>
        <input v-model.trim="draft.adminQq" class="control" type="text" inputmode="numeric" autocomplete="off">
      </label>
      <label class="field">
        <span class="field-label">管理员称呼</span>
        <input v-model.trim="draft.adminName" class="control" type="text" autocomplete="off">
      </label>
      <label class="field">
        <span class="field-label">上下文消息数</span>
        <input v-model.number="draft.contextMessageLimit" class="control" type="number" min="1" max="120" step="1">
      </label>
      <div class="border-y border-line py-2">
        <ToggleSwitch v-model="draft.quoteGroupReplies" label="引用群聊消息" description="回复时引用触发消息" />
      </div>
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="reply.autoReplyPrivate" label="启用私聊" />
      <ToggleSwitch v-model="reply.autoReplyBotGroup" label="启用 Bot 群聊" />
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
