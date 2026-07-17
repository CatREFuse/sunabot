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
const replyDebounceSeconds = computed({
  get: () => draft.value.replyDebounceMs / 1_000,
  set: (value: number) => (draft.value.replyDebounceMs = Math.round(value * 1_000))
});
const quoteFilter = computed({
  get: () => draft.value.quoteGroupReplyExcludedUserIds.join(", "),
  set: (value: string) => (draft.value.quoteGroupReplyExcludedUserIds = split(value))
});
function split(value: string) {
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
}
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
      <label class="field">
        <span class="field-label">输入防抖时间（秒）</span>
        <input
          v-model.number="replyDebounceSeconds"
          class="control"
          type="number"
          min="1"
          max="60"
          step="0.5"
          data-config-field="bot.replyDebounceMs"
        >
        <span class="text-xs leading-5 text-mute">同一发送者停止发送后开始回复</span>
      </label>
      <div class="grid gap-4 border-y border-line py-3 sm:col-span-2 sm:grid-cols-2 sm:items-center sm:gap-6">
        <ToggleSwitch v-model="draft.quoteGroupReplies" label="引用群聊消息" description="回复时引用触发消息" />
        <label class="field">
          <span class="field-label">过滤名单</span>
          <input
            v-model="quoteFilter"
            class="control"
            type="text"
            autocomplete="off"
            placeholder="123456789, 987654321"
          >
          <span class="text-xs leading-5 text-mute">回复这些 QQ 时不引用消息</span>
        </label>
      </div>
    </div>
    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="draft.pokeOnNoReply" label="no_reply 时戳一戳" description="Agent 结束本轮时戳一戳对方" />
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
