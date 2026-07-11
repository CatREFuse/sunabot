<script setup lang="ts">
import { Pencil, Trash2 } from "lucide-vue-next";
import { computed } from "vue";
import { formatFullDateTime } from "../../utils/format";
import { qqAvatarUrl } from "../../utils/qqIdentity";
import type { MemoryEntry } from "../../types";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = defineProps<{ entry: MemoryEntry; pendingDelete: boolean }>();
const emit = defineEmits<{ edit: [entry: MemoryEntry]; remove: [entry: MemoryEntry] }>();
const userProfile = computed(() => props.entry.source === "user_profile" && Boolean(props.entry.userId));
const nickname = computed(() => props.entry.userNickname || props.entry.userName || "未知昵称");
const eventTime = computed(() => {
  if (props.entry.occurredAt) {
    const start = formatMemoryTime(props.entry.occurredAt);
    const end = props.entry.occurredEndAt ? formatMemoryTime(props.entry.occurredEndAt) : "";
    return end ? `${start} 至 ${end}` : start;
  }
  const legacy = props.entry.time || props.entry.legacyTime;
  return legacy ? formatMemoryTime(legacy) : "";
});

function formatMemoryTime(value: string) {
  const formatted = formatFullDateTime(value);
  return formatted === "--" ? value : formatted;
}
</script>

<template>
  <article class="grid gap-4 border-b border-line py-5 lg:grid-cols-[280px_minmax(0,1fr)_auto] lg:items-start">
    <div v-if="userProfile" class="flex min-w-0 gap-3">
      <IdentityAvatar :src="qqAvatarUrl(entry.userId)" :name="nickname" size="lg" />
      <div class="min-w-0 space-y-1">
        <strong class="block truncate text-sm font-medium text-display">{{ nickname }}</strong>
        <p class="font-mono text-[10px] text-mute">QQ 昵称 {{ nickname }}</p>
        <p class="font-mono text-[10px] text-mute">称呼 {{ entry.addressName || "暂无" }}</p>
        <p v-for="card in entry.groupCards" :key="`${card.groupId}-${card.card}`" class="truncate font-mono text-[10px] text-mute">群名片 {{ card.card }} · 群 {{ card.groupId }}</p>
        <p v-if="!entry.groupCards?.length" class="font-mono text-[10px] text-disabled">群名片 暂无</p>
        <p class="font-mono text-[10px] text-disabled">QQ {{ entry.userId }}</p>
      </div>
    </div>
    <div v-else class="min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">{{ entry.sourceTitle }}</span>
      <p class="mt-1 truncate font-mono text-[10px] text-disabled">{{ entry.field }}</p>
    </div>

    <div class="min-w-0">
      <p class="whitespace-pre-wrap break-words text-sm leading-6 text-ink">{{ entry.text }}</p>
      <div class="mt-3 flex flex-wrap gap-4 font-mono text-[10px] text-disabled">
        <span v-if="entry.score != null">SCORE {{ entry.score.toFixed(3) }}</span>
        <span v-if="eventTime">发生 {{ eventTime }}</span>
        <span v-if="entry.updatedAt || entry.createdAt">更新 {{ formatFullDateTime(entry.updatedAt || entry.createdAt) }}</span>
      </div>
    </div>

    <div v-if="entry.editable" class="flex items-center justify-end gap-2">
      <button class="icon-btn" type="button" aria-label="编辑记忆" @click="emit('edit', entry)"><Pencil :size="16" :stroke-width="1.5" /></button>
      <button class="btn px-3" :class="pendingDelete ? 'btn-danger' : 'btn-ghost'" type="button" @click="emit('remove', entry)"><Trash2 :size="15" :stroke-width="1.5" />{{ pendingDelete ? "确认删除" : "删除" }}</button>
    </div>
  </article>
</template>
