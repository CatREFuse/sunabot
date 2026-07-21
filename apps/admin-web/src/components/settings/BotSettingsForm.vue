<script setup lang="ts">
import { computed } from "vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";
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
      <p class="mt-2 text-sm leading-6 text-mute">设置回复时机、范围、群聊引用和唤醒方式。</p>
    </div>
    <div class="settings-group grid gap-5">
      <h3 class="settings-group-title">回复时机</h3>
      <div class="grid gap-5 sm:grid-cols-2">
        <label class="field">
          <span class="field-label">上下文消息数</span>
          <SettingsConfirmInput v-model.number="draft.contextMessageLimit" type="number" min="1" max="120" step="1" confirm-label="确认上下文消息数" />
        </label>
        <label class="field">
          <span class="field-label">输入防抖时间（秒）</span>
          <SettingsConfirmInput
            v-model.number="replyDebounceSeconds"
            type="number"
            min="1"
            max="60"
            step="0.5"
            data-config-field="bot.replyDebounceMs"
            confirm-label="确认输入防抖时间"
          />
          <span class="text-xs leading-5 text-mute">同一发送者停止发送后开始回复</span>
        </label>
      </div>
    </div>
    <div class="settings-group grid gap-4">
      <h3 class="settings-group-title">群聊引用</h3>
      <div class="grid gap-4 border-y border-line py-3 sm:grid-cols-2 sm:items-center sm:gap-6">
        <ToggleSwitch v-model="draft.quoteGroupReplies" label="引用群聊消息" description="回复时引用触发消息" />
        <label class="field">
          <span class="field-label">过滤名单</span>
          <SettingsConfirmInput v-model="quoteFilter" type="text" autocomplete="off" placeholder="123456789, 987654321" confirm-label="确认过滤名单" />
          <span class="text-xs leading-5 text-mute">回复这些 QQ 时不引用消息</span>
        </label>
      </div>
    </div>
    <div class="settings-group grid gap-4">
      <h3 class="settings-group-title">回复范围</h3>
      <div class="divide-y divide-line border-y border-line">
        <ToggleSwitch v-model="reply.autoReplyPrivate" label="启用私聊" />
        <ToggleSwitch v-model="reply.autoReplyBotGroup" label="启用 Bot 群聊" />
        <ToggleSwitch v-model="draft.pokeOnNoReply" label="no_reply 时戳一戳" description="Agent 结束本轮时戳一戳对方" />
      </div>
    </div>
    <div class="settings-group grid gap-5">
      <h3 class="settings-group-title">唤醒方式</h3>
      <div class="grid gap-5 sm:grid-cols-2">
        <label class="field">
          <span class="field-label">名称</span>
          <SettingsConfirmInput v-model="names" type="text" placeholder="角色名, Agent 名" confirm-label="确认名称" />
        </label>
        <label class="field">
          <span class="field-label">命令前缀</span>
          <SettingsConfirmInput v-model="prefixes" type="text" placeholder="/, !" confirm-label="确认命令前缀" />
        </label>
      </div>
    </div>
  </section>
</template>
