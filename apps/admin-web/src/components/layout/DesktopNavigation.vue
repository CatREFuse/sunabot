<script setup lang="ts">
import { useRuntimeStatus } from "../../composables/useRuntimeStatus";
import { useTheme } from "../../composables/useTheme";
import AgentSwitcher from "../agents/AgentSwitcher.vue";
import { navigationSections, themeItems } from "./navigationCatalog";
const theme = useTheme();
const runtime = useRuntimeStatus();
</script>

<template>
  <aside class="hidden h-full min-h-0 w-[88px] shrink-0 flex-col border-r border-line bg-panel lg:flex xl:w-[224px]">
    <div class="px-3 pt-3">
      <h2 class="hidden px-3 pb-2 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled xl:block">Agent</h2>
      <span class="sr-only xl:hidden">Agent</span>
      <div class="border-y border-line py-1">
        <AgentSwitcher />
      </div>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 pt-2" aria-label="主导航">
      <section v-for="section in navigationSections" :key="section.label" class="border-t border-line pb-2 first:border-t-0 first:pt-0">
        <h2 v-if="section.label !== 'Agent'" class="hidden px-3 pb-2 pt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled xl:block">{{ section.label }}</h2>
        <span v-if="section.label !== 'Agent'" class="sr-only xl:hidden">{{ section.label }}</span>
        <RouterLink
          v-for="item in section.items"
          :key="item.to"
          :to="item.to"
          :title="item.label"
          :aria-label="item.label"
          class="desktop-nav-link group relative flex min-h-11 items-center justify-center gap-3 px-3 font-mono text-xs text-disabled transition-colors duration-200 hover:text-display xl:justify-start"
          active-class="is-active !text-display"
        >
          <i class="bx text-2xl" :class="item.icon" aria-hidden="true"></i>
          <span class="hidden xl:inline">{{ item.label }}</span>
        </RouterLink>
      </section>
    </nav>

    <div class="border-t border-line p-3">
      <div class="mb-3 hidden items-center justify-between px-2 xl:flex">
        <span class="meta-label">OneBot</span>
        <span class="font-mono text-[10px]" :class="runtime.status.value?.onebot.connected ? 'text-success' : 'text-mute'">
          {{ runtime.status.value?.onebot.connected ? "在线" : "离线" }}
        </span>
      </div>
      <div class="grid grid-cols-1 gap-1 xl:grid-cols-3" aria-label="主题">
        <button
          v-for="item in themeItems"
          :key="item.id"
          class="theme-icon-button relative grid min-h-11 place-items-center bg-transparent text-disabled transition-colors duration-200 hover:text-display"
          :class="{ 'text-display': theme.preference.value === item.id }"
          type="button"
          :title="item.label"
          :aria-pressed="theme.preference.value === item.id"
          @click="theme.setTheme(item.id)"
        >
          <i class="bx text-2xl" :class="item.icon" aria-hidden="true"></i>
          <span class="sr-only">{{ item.label }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.desktop-nav-link::before,
.theme-icon-button::after {
  position: absolute;
  content: "";
  background: rgb(var(--color-display));
  transition: opacity 180ms cubic-bezier(0.25, 0.1, 0.25, 1);
}

.desktop-nav-link::before {
  top: 50%;
  left: 0;
  width: 2px;
  height: 24px;
  opacity: 0;
  transform: translateY(-50%);
}

.desktop-nav-link.is-active::before {
  opacity: 1;
}

.theme-icon-button::after {
  right: 50%;
  bottom: 3px;
  width: 16px;
  height: 2px;
  opacity: 0;
  transform: translateX(50%);
}

.theme-icon-button[aria-pressed="true"]::after {
  opacity: 1;
}
</style>
