<script setup lang="ts">
import type { OneBotChatList } from "../../types";
import DialogOverlay from "../ui/DialogOverlay.vue";
defineProps<{ open: boolean; chats: OneBotChatList | null; loading: boolean; error: string }>();
const emit = defineEmits<{ close: []; refresh: [] }>();
</script>

<template>
  <DialogOverlay :open="open" placement="right" :z-index="60" labelledby="onebot-chats-title" @close="emit('close')">
    <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-visible bg-panel p-4 md:p-6">
      <header class="flex items-center justify-between border-b border-line pb-4">
        <div><p class="page-kicker">ONEBOT CHATS</p><h2 id="onebot-chats-title" class="mt-1 text-xl font-medium text-display">QQ 联系人</h2></div>
        <div class="flex gap-2">
          <button class="icon-btn" type="button" :disabled="loading" aria-label="刷新" @click="emit('refresh')"><i class="bx bx-refresh text-xl" aria-hidden="true"></i></button>
          <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')"><i class="bx bx-x text-2xl" aria-hidden="true"></i></button>
        </div>
      </header>
      <p v-if="loading" class="py-12 text-center font-mono text-xs text-mute">[LOADING...]</p>
      <p v-else-if="error" class="py-8 font-mono text-xs text-accent">[ERROR: {{ error }}]</p>
      <template v-else>
        <section class="mt-6">
          <h3 class="field-label">好友 · {{ chats?.private.length ?? 0 }}</h3>
          <div class="mt-2">
            <div v-for="item in chats?.private" :key="item.userId" class="divider-row">
              <span class="min-w-0"><strong class="block truncate text-sm font-normal text-display">{{ item.remark || item.nickname || item.userId }}</strong><small class="font-mono text-[10px] text-mute">{{ item.userId }}</small></span>
              <span class="truncate text-xs text-mute">{{ item.nickname }}</span>
            </div>
          </div>
        </section>
        <section class="mt-10">
          <h3 class="field-label">群聊 · {{ chats?.groups.length ?? 0 }}</h3>
          <div class="mt-2">
            <div v-for="item in chats?.groups" :key="item.groupId" class="divider-row">
              <span class="min-w-0"><strong class="block truncate text-sm font-normal text-display">{{ item.groupName || item.groupId }}</strong><small class="font-mono text-[10px] text-mute">{{ item.groupId }}</small></span>
              <span class="font-mono text-[10px] text-mute">{{ item.memberCount }}/{{ item.maxMemberCount }}</span>
            </div>
          </div>
        </section>
        <div v-if="!chats?.private.length && !chats?.groups.length" class="empty-state"><div><strong>没有联系人</strong><p>OneBot 在线后刷新</p></div></div>
      </template>
    </aside>
  </DialogOverlay>
</template>
