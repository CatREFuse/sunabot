<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime } from "../../utils/format";
import { conversationAvatarUrl, conversationIdentityDetail } from "../../utils/qqIdentity";
import type { ConversationRecord } from "../../types";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

type Scope = "all" | ConversationRecord["scope"];
const props = defineProps<{ conversations: readonly ConversationRecord[]; selectedId: string; loading: boolean }>();
const emit = defineEmits<{ select: [id: string]; refresh: [] }>();
const query = defineModel<string>("query", { required: true });
const scope = defineModel<Scope>("scope", { required: true });
const scopes: Array<{ id: Scope; label: string }> = [
  { id: "all", label: "全部" },
  { id: "private", label: "私聊" },
  { id: "user_group", label: "群聊" },
  { id: "bot_group", label: "BOT" }
];
const visible = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return props.conversations.filter((item) => {
    if (scope.value !== "all" && item.scope !== scope.value) return false;
    return !term || `${item.title} ${item.nickname ?? ""} ${item.remark ?? ""} ${item.lastText} ${item.userId} ${item.groupId ?? ""}`.toLocaleLowerCase().includes(term);
  });
});
function scopeLabel(value: ConversationRecord["scope"]) {
  if (value === "private") return "私聊";
  if (value === "bot_group") return "BOT 群聊";
  return "群聊";
}
</script>

<template>
  <aside class="flex h-full min-h-0 min-w-0 flex-col border-r border-line bg-panel">
    <header class="flex min-h-20 items-center justify-between gap-3 border-b border-line px-4">
      <h1 class="text-3xl font-medium leading-none tracking-[-0.03em] text-display">会话</h1>
      <button class="icon-btn" type="button" :disabled="loading" aria-label="刷新会话" @click="emit('refresh')">
        <i class="bx bx-refresh text-xl" aria-hidden="true"></i>
      </button>
    </header>
    <div class="grid gap-3 border-b border-line p-4">
      <label class="flex min-h-11 items-center gap-2 border-b border-visible px-1">
        <i class="bx bx-search text-lg text-mute" aria-hidden="true"></i>
        <input v-model="query" class="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-disabled" type="search" placeholder="搜索会话" autocomplete="off" aria-label="搜索会话">
      </label>
      <div class="segmented w-full" aria-label="会话类型">
        <button v-for="item in scopes" :key="item.id" class="segmented-button flex-1 px-1" type="button" :aria-pressed="scope === item.id" @click="scope = item.id">{{ item.label }}</button>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="item in visible"
        :key="item.id"
        class="grid min-h-[88px] w-full min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] gap-x-3 border-b border-line px-4 py-3 text-left hover:bg-raised"
        :class="selectedId === item.id ? 'border-l-2 border-l-accent bg-raised' : 'border-l-2 border-l-transparent'"
        type="button"
        @click="emit('select', item.id)"
      >
        <IdentityAvatar class="row-span-3 self-center" :src="conversationAvatarUrl(item)" :name="item.title" />
        <strong class="truncate text-sm font-medium text-display">{{ item.title }}</strong>
        <time class="font-mono text-[10px] text-disabled">{{ formatDateTime(item.lastAt) }}</time>
        <span class="truncate text-xs text-mute">{{ item.lastText || "暂无消息" }}</span>
        <span class="font-mono text-[10px] text-mute">{{ scopeLabel(item.scope) }}</span>
        <span class="truncate font-mono text-[10px] text-disabled">{{ item.messageCount }} 条 · {{ conversationIdentityDetail(item) }}</span>
        <span class="font-mono text-[10px]" :class="item.replyEnabled === false ? 'text-warning' : 'text-success'">{{ item.replyEnabled === false ? "已暂停" : "已启用" }}</span>
      </button>
      <div v-if="!visible.length" class="empty-state"><div><strong>{{ loading ? "加载中" : "没有会话" }}</strong><p>调整筛选条件或刷新</p></div></div>
    </div>
  </aside>
</template>
