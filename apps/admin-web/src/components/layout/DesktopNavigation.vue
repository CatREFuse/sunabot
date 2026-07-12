<script setup lang="ts">
import { useRuntimeStatus } from "../../composables/useRuntimeStatus";
import { useTheme, type ThemePreference } from "../../composables/useTheme";

const navItems: Array<{ to: string; label: string; icon: string }> = [
  { to: "/overview", label: "状态", icon: "bx-pulse" },
  { to: "/web-chat", label: "Web Chat", icon: "bx-chat" },
  { to: "/conversations", label: "会话", icon: "bx-message-square-dots" },
  { to: "/prompts", label: "提示词", icon: "bx-bot" },
  { to: "/memory", label: "记忆", icon: "bx-brain" },
  { to: "/images", label: "图像", icon: "bx-image" },
  { to: "/logs", label: "日志", icon: "bx-terminal" },
  { to: "/settings", label: "设置", icon: "bx-cog" }
];
const themeItems: Array<{ id: ThemePreference; label: string; icon: string }> = [
  { id: "light", label: "浅色", icon: "bx-sun" },
  { id: "dark", label: "深色", icon: "bx-moon" },
  { id: "system", label: "系统", icon: "bx-desktop" }
];
const theme = useTheme();
const runtime = useRuntimeStatus();
</script>

<template>
  <aside class="hidden h-full min-h-0 w-[88px] shrink-0 flex-col border-r border-line bg-panel lg:flex xl:w-[224px]">
    <div class="flex h-24 items-center gap-3 border-b border-line px-5 lg:px-6">
      <span class="grid size-11 shrink-0 place-items-center text-display">
        <i class="bx bx-bot text-[36px]" aria-hidden="true"></i>
      </span>
      <div class="hidden min-w-0 xl:block">
        <strong class="block text-lg font-medium tracking-[-0.02em] text-display">Sunabot</strong>
      </div>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label="主导航">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="desktop-nav-link group relative flex min-h-12 items-center justify-center gap-3 px-3 font-mono text-xs text-disabled transition-colors duration-200 hover:text-display xl:justify-start"
        active-class="is-active !text-display"
      >
        <i class="bx text-2xl" :class="item.icon" aria-hidden="true"></i>
        <span class="hidden xl:inline">{{ item.label }}</span>
      </RouterLink>
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
