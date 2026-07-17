<script setup lang="ts">
import type { McpApprovalTicket } from "../../types/agentExtensions";

defineProps<{ approvals: readonly McpApprovalTicket[]; busy: boolean }>();
const emit = defineEmits<{ approve: [ticket: McpApprovalTicket] }>();
</script>

<template>
  <section v-if="approvals.length" class="border-y border-warning py-5" aria-labelledby="mcp-approval-title">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div><p class="meta-label text-warning">Approval Queue</p><h2 id="mcp-approval-title" class="mt-2 text-xl font-medium text-display">待批准的 MCP 请求</h2></div>
      <span class="font-display text-3xl font-semibold text-warning">{{ approvals.length }}</span>
    </header>
    <article v-for="ticket in approvals" :key="ticket.id" class="grid gap-4 border-b border-line py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div class="min-w-0">
        <strong class="text-display">{{ ticket.serverId }} / {{ ticket.toolName }}</strong>
        <p class="mt-2 break-all font-mono text-[10px] leading-5 text-mute">{{ JSON.stringify(ticket.arguments) }}</p>
        <p class="mt-2 font-mono text-[10px] text-mute">{{ ticket.transport }} · {{ ticket.conversationId }} · 到期 {{ new Date(ticket.expiresAt).toLocaleTimeString() }}</p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="busy" @click="emit('approve', ticket)">批准一次</button>
    </article>
  </section>
</template>
