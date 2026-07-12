<script setup lang="ts">
import { computed } from "vue";
import { authenticatedMediaPath } from "../../composables/useAdminApi";
import { formatFullDateTime } from "../../utils/format";
import { displayMessageText } from "../../utils/messageText";
import { messageQq, qqAvatarUrl } from "../../utils/qqIdentity";
import { toolIcon } from "../../utils/toolCatalog";
import type { ConversationMessageRecord, ConversationRecord } from "../../types";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = withDefaults(defineProps<{
  message: ConversationMessageRecord;
  conversation: ConversationRecord;
  memberNames?: Readonly<Record<string, string>>;
}>(), { memberNames: () => ({}) });
const emit = defineEmits<{ logs: [runId: string] }>();
const assistant = computed(() => props.message.role === "assistant");
const event = computed(() => props.message.role === "event");
const requestRunning = computed(() => props.message.requestStatus === "running");
const orchestratorDecision = computed(() => props.message.eventKind === "orchestrator_decision"
  ? props.message.orchestratorDecision
  : undefined);
const botMessage = computed(() => assistant.value || Boolean(orchestratorDecision.value));
const orchestratorDecisionLabel = computed(() => {
  if (orchestratorDecision.value?.status === "failed") return "判断失败";
  return orchestratorDecision.value?.shouldReply ? "触发回复" : "保持沉默";
});
const orchestratorDecisionText = computed(() => orchestratorDecision.value?.reason.trim() || orchestratorDecision.value?.raw.trim() || "");
const qq = computed(() => orchestratorDecision.value
  ? String(props.message.selfId ?? props.conversation.selfId ?? "")
  : messageQq(props.message, props.conversation));
const nickname = computed(() => props.message.senderNickname?.trim() ?? "");
const card = computed(() => props.message.senderCard?.trim() ?? "");
const roleName = computed(() => props.message.role === "assistant" ? "普拉娜" : props.message.role === "event" ? "系统" : "用户");
const displayName = computed(() => card.value || nickname.value || props.message.senderName?.trim() || (orchestratorDecision.value ? "普拉娜" : roleName.value));
const identityDetails = computed(() => {
  const seen = new Set([identityKey(displayName.value)]);
  return [
    { label: "群名片", value: card.value },
    { label: "QQ 昵称", value: nickname.value },
    { label: "QQ", value: qq.value }
  ].filter(({ value }) => {
    const key = identityKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
const messageText = computed(() => displayMessageText(props.message.text, props.message.imageUrls, props.memberNames));
const quotes = computed(() => orchestratorDecision.value
  ? []
  : (props.message.quoteReferences ?? []).map((quote) => ({
      ...quote,
      displayText: displayMessageText(quote.text ?? "", quote.imageUrls, props.memberNames)
    })));
const avatar = computed(() => qqAvatarUrl(qq.value));
const messageTraceVisible = computed(() => assistant.value && !requestRunning.value && !orchestratorDecision.value);
const messageOrigin = computed(() => {
  switch (props.message.messageOrigin) {
    case "text": return { label: "text", icon: "bx-message-square-detail" };
    case "assistant_text": return { label: "assistant_text", icon: "bx-message-rounded-dots" };
    case "async_tool_dispatch": return { label: "dispatch_message", icon: "bx-send" };
    case "async_tool_callback": return { label: "async_tool_callback", icon: "bx-reply" };
    default: return { label: "未记录", icon: "bx-history" };
  }
});
const visibleToolNames = computed(() => {
  const names = new Set<string>();
  for (const value of props.message.toolNames ?? []) {
    const name = value.trim();
    if (name && name !== "text") names.add(name);
  }
  return [...names];
});

function identityKey(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}
</script>

<template>
  <article v-if="event && !orchestratorDecision" class="mx-auto mb-5 max-w-full text-center">
    <div class="inline-flex max-w-full items-center gap-3 rounded-full border border-line px-4 py-2 font-mono text-[10px] text-mute">
      <span class="truncate">{{ message.text }}</span>
      <time class="shrink-0 text-disabled">{{ formatFullDateTime(message.at) }}</time>
    </div>
  </article>

  <article v-else class="mb-6 flex max-w-[94%] items-end gap-3 md:max-w-[84%]" :class="botMessage ? 'ml-auto flex-row-reverse' : 'mr-auto'">
    <IdentityAvatar :src="avatar" :name="displayName" size="lg" />
    <div class="grid min-w-0 gap-2" :class="botMessage ? 'justify-items-end' : 'justify-items-start'">
      <header class="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-mute" :class="botMessage ? 'justify-end text-right' : ''">
        <strong class="max-w-52 truncate text-xs font-medium text-display">{{ displayName }}</strong>
        <span v-for="detail in identityDetails" :key="detail.label" class="font-mono">{{ detail.label }} {{ detail.value }}</span>
        <time class="font-mono text-disabled">{{ formatFullDateTime(message.at) }}</time>
      </header>

      <div data-slot="orchestrator-result" class="grid min-w-0 max-w-full gap-3 rounded-lg border px-4 py-3" :class="botMessage ? 'rounded-br border-visible bg-display text-page' : 'rounded-bl border-line bg-panel text-ink'">
        <div v-if="orchestratorDecision" class="grid gap-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong class="text-xs font-medium">编排器结果</strong>
            <span class="font-mono text-[10px]" :class="orchestratorDecision.shouldReply ? 'text-success' : 'text-warning'">{{ orchestratorDecisionLabel }}</span>
            <span class="font-mono text-[10px] text-page/60">用户不可见</span>
          </div>
          <p v-if="orchestratorDecisionText" class="whitespace-pre-wrap break-words text-xs leading-5 text-page/75">{{ orchestratorDecisionText }}</p>
        </div>
        <blockquote v-for="quote in quotes" :key="quote.messageId" class="grid gap-2 border-l-2 pl-3 text-xs" :class="botMessage ? 'border-page/40 text-page/70' : 'border-visible text-mute'">
          <p v-if="quote.displayText">{{ quote.senderName }} · {{ quote.displayText }}</p>
          <div v-if="quote.imageUrls?.length" class="grid gap-2 sm:grid-cols-2">
            <a v-for="url in quote.imageUrls" :key="`${quote.messageId}-${url}`" :href="authenticatedMediaPath(url)" target="_blank" rel="noopener noreferrer" title="打开原图">
              <AuthenticatedImage :src="url" alt="引用图片" thumbnail class-name="max-h-64 w-full rounded object-contain" />
            </a>
          </div>
        </blockquote>
        <div v-if="requestRunning" data-slot="typing-indicator" class="flex items-center gap-3 py-0.5" role="status" aria-live="polite" aria-label="正在输入">
          <span class="text-xs text-page/70">正在输入</span>
          <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <p v-else-if="!orchestratorDecision && messageText" class="whitespace-pre-wrap break-words text-sm leading-6">{{ messageText }}</p>
        <div v-if="!orchestratorDecision && message.imageUrls?.length" class="grid gap-2 sm:grid-cols-2">
          <a v-for="url in message.imageUrls" :key="url" :href="authenticatedMediaPath(url)" target="_blank" rel="noopener noreferrer" title="打开原图">
            <AuthenticatedImage :src="url" alt="会话图片" thumbnail class-name="max-h-96 w-full rounded object-contain" />
          </a>
        </div>
        <div v-if="messageTraceVisible" data-slot="message-trace" class="flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-page/20 pt-3 font-mono text-[10px] text-page/65" aria-label="消息来源与工具">
          <span data-slot="message-origin" class="inline-flex min-w-0 items-center gap-1.5">
            <i class="bx shrink-0 text-sm text-page/85" :class="messageOrigin.icon" aria-hidden="true"></i>
            <span>来源</span>
            <strong class="break-all font-medium text-page">{{ messageOrigin.label }}</strong>
          </span>
          <span v-if="visibleToolNames.length" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <span>本轮工具</span>
            <span v-for="name in visibleToolNames" :key="name" data-slot="message-tool" class="inline-flex min-w-0 items-center gap-1 text-page/85">
              <i class="bx shrink-0 text-sm" :class="toolIcon(name)" aria-hidden="true"></i>
              <code class="break-all font-mono">{{ name }}</code>
            </span>
          </span>
          <button v-if="message.logRunId" class="font-mono underline underline-offset-4 sm:ml-auto" type="button" @click="emit('logs', message.logRunId)">查看请求日志</button>
        </div>
        <button v-else-if="message.logRunId" class="justify-self-start font-mono text-[10px] underline underline-offset-4" type="button" @click="emit('logs', message.logRunId)">查看请求日志</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.typing-dots {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.typing-dots i {
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 999px;
  background: currentColor;
  animation: typing-breathe 1s ease-in-out infinite;
}

.typing-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.typing-dots i:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes typing-breathe {
  0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-0.14rem); }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dots i { animation: none; opacity: 0.7; }
}
</style>
