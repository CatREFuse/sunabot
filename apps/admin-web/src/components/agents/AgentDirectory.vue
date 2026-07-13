<script setup lang="ts">
import type { AgentSummary } from "../../types";
import { agentAvatarUrl } from "../../utils/agentIdentity";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

defineProps<{ agents: readonly AgentSummary[]; selectedId?: string }>();
const emit = defineEmits<{ select: [agentId: string]; create: [] }>();
</script>

<template>
  <section class="min-w-0 border-r border-line lg:min-h-[620px]">
    <div class="flex min-h-16 items-center justify-between gap-4 border-b border-line px-1 lg:px-4">
      <h2 class="text-lg font-medium text-display">Agent</h2>
      <button class="btn btn-primary min-h-10 px-4" type="button" @click="emit('create')">
        <i class="bx bx-plus text-lg" aria-hidden="true"></i>
        <span>新增</span>
      </button>
    </div>
    <button
      v-for="agent in agents"
      :key="agent.id"
      class="flex min-h-20 w-full items-center gap-4 border-b border-line bg-transparent px-1 text-left transition-colors hover:bg-raised lg:px-4"
      :class="agent.id === selectedId ? 'text-display' : 'text-ink'"
      type="button"
      :aria-label="`选择 ${agent.name}`"
      @click="emit('select', agent.id)"
    >
      <IdentityAvatar :src="agentAvatarUrl(agent)" :name="agent.name" size="lg" />
      <span class="min-w-0 flex-1">
        <strong class="block truncate font-medium">{{ agent.name }}</strong>
        <small class="mt-1 block truncate font-mono text-[10px] text-mute">{{ agent.accounts.filter((item) => item.connected).length }}/{{ agent.accounts.length }} 个账号在线</small>
      </span>
      <span class="font-mono text-[10px] uppercase" :class="agent.enabled ? 'text-success' : 'text-mute'">{{ agent.enabled ? "已启用" : "已停用" }}</span>
    </button>
  </section>
</template>
