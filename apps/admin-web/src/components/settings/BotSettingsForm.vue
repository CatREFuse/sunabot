<script setup lang="ts">
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import type { ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["bot"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <p class="page-kicker">BOT</p>
      <h2 class="section-title mt-2">回复行为</h2>
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
      <div class="rounded-lg border border-line px-4 py-2">
        <ToggleSwitch v-model="draft.quoteGroupReplies" label="引用群聊消息" description="回复时引用触发消息" />
      </div>
    </div>
  </section>
</template>
