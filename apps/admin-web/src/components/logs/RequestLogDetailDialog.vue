<script setup lang="ts">
import { computed } from "vue";
import type { ConversationLogEntry } from "../../types";
import { formatFullDateTime } from "../../utils/format";
import {
  requestLogBusinessNodeName,
  requestLogDisplayName
} from "../../utils/logDisplay";
import DialogOverlay from "../ui/DialogOverlay.vue";
import StructuredValue from "./StructuredValue.vue";

const props = defineProps<{
  open: boolean;
  log: ConversationLogEntry | null;
  logs: readonly ConversationLogEntry[];
}>();
const emit = defineEmits<{ close: [] }>();

const relatedLogs = computed(() => {
  if (!props.log) return [];
  const runId = textValue(props.log.metadata?.runId);
  if (!runId) return [props.log];
  const related = props.logs.filter((candidate) => textValue(candidate.metadata?.runId) === runId);
  return related.length ? related : [props.log];
});
const requestBody = computed(() => {
  const modelRequests = relatedLogs.value
    .filter((entry) => entry.category === "model.request" && entry.request !== undefined)
    .map((entry) => entry.request);
  if (modelRequests.length) return oneOrMany(modelRequests);
  return props.log?.request;
});
const toolCalls = computed(() => relatedLogs.value
  .filter((entry) => entry.category === "tool.call")
  .map((entry) => {
    const request = objectValue(entry.request);
    return {
      name: entry.action,
      callId: request.callId,
      arguments: request.arguments ?? entry.request,
      result: entry.response
    };
  }));
const responseBody = computed(() => {
  const modelResponses = relatedLogs.value
    .filter((entry) => entry.category === "model.response" && entry.response !== undefined)
    .map((entry) => entry.response);
  if (modelResponses.length) return oneOrMany(modelResponses);
  return props.log?.response;
});
const metadata = computed(() => props.log?.metadata);

function oneOrMany(values: unknown[]) {
  return values.length === 1 ? values[0] : values;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
</script>

<template>
  <DialogOverlay
    :open="open"
    placement="right"
    aria-label="请求详情"
    @close="emit('close')"
  >
    <section v-if="log" class="request-detail">
      <header class="request-detail__header">
        <button class="icon-btn request-detail__close" type="button" aria-label="关闭请求详情" data-dialog-initial-focus @click="emit('close')">
          <i class="bx bx-x text-xl" aria-hidden="true"></i>
        </button>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="request-detail__eyebrow">{{ requestLogBusinessNodeName(log) }}</span>
            <span v-if="log.presentation?.status === 'error'" class="request-detail__error">[ERROR]</span>
            <span v-else-if="log.presentation?.status === 'success'" class="request-detail__success">[OK]</span>
          </div>
          <h2 class="mt-3 text-xl font-medium text-display">{{ requestLogDisplayName(log) }}</h2>
          <p class="mt-2 break-all font-mono text-[11px] text-mute">{{ log.action }}</p>
        </div>
      </header>

      <dl class="request-detail__facts">
        <div>
          <dt>TIME</dt>
          <dd>{{ formatFullDateTime(log.at) }}</dd>
        </div>
        <div>
          <dt>PROVIDER</dt>
          <dd>{{ log.providerId || "--" }}</dd>
        </div>
        <div>
          <dt>MODEL</dt>
          <dd>{{ log.model || "--" }}</dd>
        </div>
        <div :data-error="Boolean(log.presentation?.retryCount)">
          <dt>RETRY</dt>
          <dd>{{ log.presentation?.retryCount ?? 0 }} · {{ log.presentation?.attempt ?? 1 }}/{{ log.presentation?.maxAttempts ?? 1 }}</dd>
        </div>
      </dl>

      <div class="request-detail__body">
        <section class="request-detail__section" aria-labelledby="request-detail-request">
          <h3 id="request-detail-request">REQUEST BODY</h3>
          <StructuredValue v-if="requestBody !== undefined" :value="requestBody" />
          <p v-else class="request-detail__empty">NO DATA</p>
        </section>
        <section class="request-detail__section" aria-labelledby="request-detail-tools">
          <h3 id="request-detail-tools">TOOL CALL</h3>
          <div v-if="toolCalls.length" class="request-detail__tools">
            <div v-for="(toolCall, index) in toolCalls" :key="`${String(toolCall.callId ?? toolCall.name)}:${index}`" class="request-detail__tool">
              <div class="request-detail__tool-head">
                <strong>{{ toolCall.name }}</strong>
                <span>{{ toolCall.callId || "--" }}</span>
              </div>
              <p>ARGUMENTS</p>
              <StructuredValue :value="toolCall.arguments" />
              <p>RESULT</p>
              <StructuredValue :value="toolCall.result" />
            </div>
          </div>
          <p v-else class="request-detail__empty">NO TOOL CALL</p>
        </section>
        <section class="request-detail__section" aria-labelledby="request-detail-response">
          <h3 id="request-detail-response">RESPONSE BODY</h3>
          <StructuredValue v-if="responseBody !== undefined" :value="responseBody" />
          <p v-else class="request-detail__empty">NO DATA</p>
        </section>
        <section class="request-detail__section" aria-labelledby="request-detail-metadata">
          <h3 id="request-detail-metadata">METADATA</h3>
          <StructuredValue v-if="metadata !== undefined" :value="metadata" />
          <p v-else class="request-detail__empty">NO DATA</p>
        </section>
      </div>
    </section>
  </DialogOverlay>
</template>

<style scoped>
.request-detail {
  display: flex;
  width: min(760px, 100vw);
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid rgb(var(--color-line));
  background: rgb(var(--color-panel));
}
.request-detail__header {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 16px;
  padding: 24px;
  border-bottom: 1px solid rgb(var(--color-line));
}
.request-detail__close { border-radius: 0; }
.request-detail__eyebrow,
.request-detail__error,
.request-detail__success {
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.request-detail__eyebrow { color: rgb(var(--color-mute)); }
.request-detail__error { color: rgb(var(--color-accent)); }
.request-detail__success { color: rgb(var(--color-success)); }
.request-detail__facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid rgb(var(--color-line));
}
.request-detail__facts > div {
  min-width: 0;
  padding: 16px;
  border-right: 1px solid rgb(var(--color-line));
}
.request-detail__facts > div:last-child { border-right: 0; }
.request-detail__facts dt,
.request-detail__section h3 {
  font-family: "Space Mono", monospace;
  font-size: 10px;
  letter-spacing: .1em;
}
.request-detail__facts dt { color: rgb(var(--color-disabled)); }
.request-detail__facts dd {
  margin-top: 8px;
  overflow-wrap: anywhere;
  font-family: "Space Mono", monospace;
  font-size: 11px;
  color: rgb(var(--color-display));
}
.request-detail__facts [data-error="true"] dd { color: rgb(var(--color-accent)); }
.request-detail__body {
  min-height: 0;
  flex: 1;
  overflow: auto;
}
.request-detail__section {
  padding: 24px;
  border-bottom: 1px solid rgb(var(--color-line));
}
.request-detail__section h3 {
  margin-bottom: 16px;
  color: rgb(var(--color-mute));
}
.request-detail__empty {
  font-family: "Space Mono", monospace;
  font-size: 11px;
  color: rgb(var(--color-disabled));
}
.request-detail__tools {
  border-top: 1px solid rgb(var(--color-line));
}
.request-detail__tool {
  padding: 16px 0;
  border-bottom: 1px solid rgb(var(--color-line));
}
.request-detail__tool-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
  margin-bottom: 16px;
  font-family: "Space Mono", monospace;
  font-size: 11px;
}
.request-detail__tool-head strong { color: rgb(var(--color-display)); }
.request-detail__tool-head span { color: rgb(var(--color-disabled)); }
.request-detail__tool > p {
  margin: 16px 0 8px;
  color: rgb(var(--color-disabled));
  font-family: "Space Mono", monospace;
  font-size: 9px;
  letter-spacing: .08em;
}
@media (max-width: 640px) {
  .request-detail { border-left: 0; }
  .request-detail__header { padding: 16px; }
  .request-detail__facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .request-detail__facts > div:nth-child(2) { border-right: 0; }
  .request-detail__facts > div:nth-child(-n+2) { border-bottom: 1px solid rgb(var(--color-line)); }
  .request-detail__section { padding: 20px 16px; }
}
</style>
