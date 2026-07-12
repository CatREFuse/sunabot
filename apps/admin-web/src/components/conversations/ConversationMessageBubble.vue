<script setup lang="ts">
import { computed } from "vue";
import { authenticatedMediaPath } from "../../composables/useAdminApi";
import { formatFullDateTime } from "../../utils/format";
import { displayMessageText } from "../../utils/messageText";
import { messageQq, qqAvatarUrl } from "../../utils/qqIdentity";
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
const displayName = computed(() => card.value || nickname.value || props.message.senderName?.trim() || (orchestratorDecision.value ? "普拉娜" : props.message.role));
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

      <div data-slot="orchestrator-result" class="grid min-w-0 max-w-full gap-3 rounded-2xl border px-4 py-3" :class="botMessage ? 'rounded-br-md border-visible bg-display text-page' : 'rounded-bl-md border-line bg-panel text-ink'">
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
              <AuthenticatedImage :src="url" alt="引用图片" thumbnail class-name="max-h-64 w-full rounded-lg object-contain" />
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
            <AuthenticatedImage :src="url" alt="会话图片" thumbnail class-name="max-h-96 w-full rounded-lg object-contain" />
          </a>
        </div>
        <button v-if="message.logRunId" class="justify-self-start font-mono text-[10px] underline underline-offset-4" type="button" @click="emit('logs', message.logRunId)">查看请求日志</button>
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
