<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useId, useTemplateRef } from "vue";
import { useRouter } from "vue-router";
import { useRoute } from "vue-router";
import { useAgents } from "../../composables/useAgents";
import { agentAvatarUrl } from "../../utils/agentIdentity";
import IdentityAvatar from "../ui/IdentityAvatar.vue";

withDefaults(defineProps<{ compact?: boolean; expanded?: boolean }>(), {
  compact: false,
  expanded: false
});
const agentsState = useAgents();
const router = useRouter();
const route = useRoute();
const open = shallowRef(false);
const activeIndex = shallowRef(-1);
const root = useTemplateRef<HTMLElement>("root");
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
const listboxId = `agent-switcher-${useId()}`;
const avatar = computed(() => agentAvatarUrl(agentsState.currentAgent.value));

onMounted(() => {
  void agentsState.load().catch(() => undefined);
  document.addEventListener("pointerdown", closeFromOutside, true);
  document.addEventListener("focusin", closeFromFocusOutside, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeFromOutside, true);
  document.removeEventListener("focusin", closeFromFocusOutside, true);
});

function optionElements() {
  return [...(root.value?.querySelectorAll<HTMLButtonElement>("[data-agent-option]") ?? [])];
}

async function openMenu(position: "selected" | "first" | "last" = "selected") {
  const count = agentsState.agents.value.length;
  if (!count) return;
  if (position === "first") activeIndex.value = 0;
  else if (position === "last") activeIndex.value = count - 1;
  else {
    const selected = agentsState.agents.value.findIndex((agent) => agent.id === agentsState.currentAgent.value?.id);
    activeIndex.value = selected >= 0 ? selected : 0;
  }
  open.value = true;
  await nextTick();
  optionElements()[activeIndex.value]?.focus({ preventScroll: true });
}

function closeMenu(restoreFocus = false) {
  open.value = false;
  activeIndex.value = -1;
  if (restoreFocus) void nextTick(() => trigger.value?.focus({ preventScroll: true }));
}

function toggleMenu() {
  if (open.value) closeMenu();
  else void openMenu();
}

function closeFromOutside(event: PointerEvent) {
  if (!open.value || !(event.target instanceof Node) || root.value?.contains(event.target)) return;
  closeMenu();
}

function closeFromFocusOutside(event: FocusEvent) {
  if (!open.value || !(event.target instanceof Node) || root.value?.contains(event.target)) return;
  closeMenu();
}

function focusOption(index: number) {
  const options = optionElements();
  if (!options.length) return;
  activeIndex.value = (index + options.length) % options.length;
  options[activeIndex.value]?.focus({ preventScroll: true });
}

function handleTriggerKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    void openMenu(event.key === "ArrowDown" ? "first" : "last");
  } else if (event.key === "Escape" && open.value) {
    event.preventDefault();
    closeMenu(true);
  }
}

function handleMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusOption(activeIndex.value + (event.key === "ArrowDown" ? 1 : -1));
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusOption(event.key === "Home" ? 0 : optionElements().length - 1);
  }
}

function select(agentId: string) {
  const changed = agentId !== agentsState.currentAgent.value?.id;
  const reload = changed && route.path !== "/agents";
  agentsState.select(agentId);
  closeMenu(!reload);
  if (reload) window.location.reload();
}

function manage() {
  closeMenu();
  void router.push("/agents");
}
</script>

<template>
  <div ref="root" class="relative min-w-0">
    <button
      ref="trigger"
      class="flex min-h-14 w-full items-center gap-3 bg-transparent px-2 text-left text-ink hover:text-display"
      :class="expanded ? 'justify-start' : 'justify-center xl:justify-start'"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :aria-label="agentsState.currentAgent.value ? `当前 Agent：${agentsState.currentAgent.value.name}` : '选择 Agent'"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      <IdentityAvatar :src="avatar" :name="agentsState.currentAgent.value?.name" size="lg" />
      <span v-if="!compact" class="min-w-0 flex-1" :class="expanded ? 'block' : 'hidden xl:block'">
        <strong class="block truncate text-sm font-medium text-display">{{ agentsState.currentAgent.value?.name || "Agent" }}</strong>
        <small class="block truncate font-mono text-[10px] uppercase text-mute">{{ agentsState.currentAgent.value?.id || "loading" }}</small>
      </span>
      <i v-if="!compact" class="bx bx-chevron-down text-lg text-mute" :class="expanded ? 'block' : 'hidden xl:block'" aria-hidden="true"></i>
    </button>

    <div v-if="open" class="absolute left-0 top-[calc(100%+8px)] z-50 w-[258px] border border-visible bg-panel py-2" @keydown="handleMenuKeydown">
      <div :id="listboxId" role="listbox" aria-label="Agent">
        <button
          v-for="(agent, index) in agentsState.agents.value"
          :key="agent.id"
          data-agent-option
          class="flex min-h-14 w-full items-center gap-3 border-b border-line bg-transparent px-2 text-left last:border-b-0 hover:bg-raised"
          type="button"
          role="option"
          :tabindex="index === activeIndex ? 0 : -1"
          :aria-selected="agent.id === agentsState.currentAgent.value?.id"
          @focus="activeIndex = index"
          @click="select(agent.id)"
        >
          <IdentityAvatar :src="agentAvatarUrl(agent)" :name="agent.name" size="sm" />
          <span class="min-w-0 flex-1">
            <strong class="block truncate text-sm font-normal text-display">{{ agent.name }}</strong>
            <small class="block truncate font-mono text-[10px] text-mute">{{ agent.accounts.filter((item) => item.connected).length }} 个账号在线</small>
          </span>
          <i v-if="agent.id === agentsState.currentAgent.value?.id" class="bx bx-check text-xl" aria-hidden="true"></i>
        </button>
      </div>
      <button class="mt-2 flex min-h-11 w-full items-center gap-3 border-t border-line bg-transparent px-4 pt-2 text-sm text-ink hover:text-display" type="button" @click="manage">
        <i class="bx bx-group text-xl" aria-hidden="true"></i>
        <span>管理 Agent</span>
      </button>
    </div>
  </div>
</template>
