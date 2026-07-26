<script setup lang="ts">
import { computed } from "vue";
import type { MemoryEntry } from "../../types";
import { formatFullDateTime } from "../../utils/format";
import { qqAvatarUrl } from "../../utils/qqIdentity";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = defineProps<{
  entry: MemoryEntry;
  pendingDelete: boolean;
}>();
const emit = defineEmits<{
  close: [];
  edit: [entry: MemoryEntry];
  remove: [entry: MemoryEntry];
}>();

const userProfile = computed(() => props.entry.source === "user_profile" && Boolean(props.entry.userId));
const nickname = computed(() => props.entry.userNickname || props.entry.userName || "未知昵称");
const addressNames = computed(() => props.entry.addressNames?.join("、") || props.entry.addressName || "暂无");
const displayId = computed(() => props.entry.key || props.entry.id);
const eventTime = computed(() => {
  const start = props.entry.occurredAt || props.entry.time || props.entry.legacyTime;
  if (!start) return "";
  const startLabel = formatMemoryTime(start);
  const endLabel = props.entry.occurredEndAt ? formatMemoryTime(props.entry.occurredEndAt) : "";
  return endLabel ? `${startLabel} 至 ${endLabel}` : startLabel;
});
const recallSummary = computed(() => {
  const parts = [];
  if (props.entry.recallCount != null) parts.push(`${props.entry.recallCount} 次`);
  if (props.entry.distinctRecallDays != null) parts.push(`跨 ${props.entry.distinctRecallDays} 天`);
  return parts.join(" · ");
});

function formatMemoryTime(value: string) {
  const formatted = formatFullDateTime(value);
  return formatted === "--" ? value : formatted;
}
</script>

<template>
  <aside class="flex min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden bg-panel" aria-label="记忆详情">
    <header class="flex min-w-0 items-start justify-between gap-5 border-b border-line pb-5">
      <div class="min-w-0">
        <p class="field-label">记录详情</p>
        <h2 class="mt-2 text-lg font-medium text-display">{{ entry.sourceTitle }}</h2>
        <p class="mt-2 truncate font-mono text-[10px] text-mute" :title="displayId">#{{ displayId }}</p>
      </div>
      <button class="icon-btn -mt-2 shrink-0" type="button" aria-label="关闭记忆详情" @click="emit('close')">
        <i class="bx bx-x" aria-hidden="true"></i>
      </button>
    </header>

    <div class="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto py-6">
      <section v-if="userProfile" class="flex min-w-0 gap-4 border-b border-line pb-6">
        <IdentityAvatar :src="qqAvatarUrl(entry.userId)" :name="nickname" size="lg" />
        <div class="min-w-0">
          <h2 class="truncate text-lg font-medium text-display">{{ nickname }}</h2>
          <p class="mt-1 font-mono text-[11px] text-mute">QQ {{ entry.userId }}</p>
          <p class="mt-2 text-sm text-ink">{{ addressNames }}</p>
        </div>
      </section>

      <section class="min-w-0" :class="userProfile ? 'pt-6' : ''">
        <h2 class="field-label">内容</h2>
        <p class="mt-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-7 text-ink">{{ entry.text }}</p>
      </section>

      <section class="mt-8 min-w-0 border-t border-line pt-6">
        <h2 class="field-label">记录</h2>
        <dl class="mt-4 grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs">
          <template v-if="eventTime">
            <dt class="text-mute">发生时间</dt>
            <dd class="min-w-0 break-words [overflow-wrap:anywhere] text-right font-mono text-[11px] text-ink">{{ eventTime }}</dd>
          </template>
          <template v-if="entry.createdAt || entry.legacyCreatedAt">
            <dt class="text-mute">添加时间</dt>
            <dd class="min-w-0 break-words [overflow-wrap:anywhere] text-right font-mono text-[11px] text-ink">{{ formatFullDateTime(entry.createdAt || entry.legacyCreatedAt) }}</dd>
          </template>
          <template v-if="entry.updatedAt">
            <dt class="text-mute">更新时间</dt>
            <dd class="min-w-0 break-words [overflow-wrap:anywhere] text-right font-mono text-[11px] text-ink">{{ formatFullDateTime(entry.updatedAt) }}</dd>
          </template>
          <template v-if="recallSummary">
            <dt class="text-mute">召回</dt>
            <dd class="text-right font-mono text-[11px] text-ink">{{ recallSummary }}</dd>
          </template>
          <template v-if="entry.lastRecalledAt">
            <dt class="text-mute">最近召回</dt>
            <dd class="min-w-0 break-words [overflow-wrap:anywhere] text-right font-mono text-[11px] text-ink">{{ formatFullDateTime(entry.lastRecalledAt) }}</dd>
          </template>
          <template v-if="entry.score != null">
            <dt class="text-mute">相关度</dt>
            <dd class="text-right font-mono text-[11px] text-ink">{{ entry.score.toFixed(3) }}</dd>
          </template>
        </dl>
      </section>

      <section v-if="userProfile && entry.groupCards?.length" class="mt-8 border-t border-line pt-6">
        <h2 class="field-label">群名片</h2>
        <ul class="mt-3 space-y-2">
          <li v-for="card in entry.groupCards" :key="`${card.groupId}-${card.card}`" class="flex justify-between gap-4 text-xs">
            <span class="min-w-0 truncate text-ink">{{ card.card }}</span>
            <span class="shrink-0 font-mono text-[11px] text-mute">{{ card.groupId }}</span>
          </li>
        </ul>
      </section>
    </div>

    <footer v-if="entry.editable" class="grid grid-cols-2 gap-2 border-t border-line pt-5">
      <button class="btn rounded" type="button" @click="emit('edit', entry)">
        <i class="bx bx-edit" aria-hidden="true"></i>编辑
      </button>
      <button class="btn rounded" :class="pendingDelete ? 'btn-danger' : ''" type="button" @click="emit('remove', entry)">
        <i class="bx bx-trash" aria-hidden="true"></i>{{ pendingDelete ? "确认删除" : "删除" }}
      </button>
    </footer>
  </aside>
</template>
