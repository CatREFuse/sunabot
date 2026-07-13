<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { useRouter } from "vue-router";
import { useRoute } from "vue-router";
import { useAgents } from "../../composables/useAgents";
import { agentAvatarUrl } from "../../utils/agentIdentity";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

const props = withDefaults(defineProps<{ compact?: boolean; expanded?: boolean }>(), {
  compact: false,
  expanded: false
});
const agentsState = useAgents();
const router = useRouter();
const route = useRoute();
const open = shallowRef(false);
const avatar = computed(() => agentAvatarUrl(agentsState.currentAgent.value));

onMounted(() => void agentsState.load().catch(() => undefined));

function select(agentId: string) {
  const changed = agentId !== agentsState.currentAgent.value?.id;
  agentsState.select(agentId);
  open.value = false;
  if (changed && route.path !== "/agents") window.location.reload();
}

function manage() {
  open.value = false;
  void router.push("/agents");
}
</script>

<template>
  <div class="relative min-w-0">
    <button
      class="flex min-h-14 w-full items-center gap-3 bg-transparent px-2 text-left text-ink hover:text-display"
      :class="expanded ? 'justify-start' : 'justify-center xl:justify-start'"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="agentsState.currentAgent.value ? `当前 Agent：${agentsState.currentAgent.value.name}` : '选择 Agent'"
      @click="open = !open"
    >
      <IdentityAvatar :src="avatar" :name="agentsState.currentAgent.value?.name" size="lg" />
      <span v-if="!compact" class="min-w-0 flex-1" :class="expanded ? 'block' : 'hidden xl:block'">
        <strong class="block truncate text-sm font-medium text-display">{{ agentsState.currentAgent.value?.name || "Agent" }}</strong>
        <small class="block truncate font-mono text-[10px] uppercase text-mute">{{ agentsState.currentAgent.value?.id || "loading" }}</small>
      </span>
      <i v-if="!compact" class="bx bx-chevron-down text-lg text-mute" :class="expanded ? 'block' : 'hidden xl:block'" aria-hidden="true"></i>
    </button>

    <div v-if="open" class="absolute left-0 top-[calc(100%+8px)] z-50 w-64 border border-visible bg-panel p-2 shadow-2xl" role="listbox" aria-label="Agent">
      <button
        v-for="agent in agentsState.agents.value"
        :key="agent.id"
        class="flex min-h-14 w-full items-center gap-3 border-b border-line bg-transparent px-2 text-left last:border-b-0 hover:bg-raised"
        type="button"
        role="option"
        :aria-selected="agent.id === agentsState.currentAgent.value?.id"
        @click="select(agent.id)"
      >
        <IdentityAvatar :src="agentAvatarUrl(agent)" :name="agent.name" size="sm" />
        <span class="min-w-0 flex-1">
          <strong class="block truncate text-sm font-normal text-display">{{ agent.name }}</strong>
          <small class="block truncate font-mono text-[10px] text-mute">{{ agent.accounts.filter((item) => item.connected).length }} 个账号在线</small>
        </span>
        <i v-if="agent.id === agentsState.currentAgent.value?.id" class="bx bx-check text-xl" aria-hidden="true"></i>
      </button>
      <button class="mt-2 flex min-h-11 w-full items-center gap-3 border-t border-line bg-transparent px-2 pt-2 text-sm text-ink hover:text-display" type="button" @click="manage">
        <i class="bx bx-group text-xl" aria-hidden="true"></i>
        <span>管理 Agent</span>
      </button>
    </div>
  </div>
</template>
