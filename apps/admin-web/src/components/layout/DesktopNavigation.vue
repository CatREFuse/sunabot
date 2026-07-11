<script setup lang="ts">
import { Bot, Brain, Image, LogOut, MessageSquare, Settings, SlidersHorizontal, Sun, Moon, Monitor } from "lucide-vue-next";
import type { Component } from "vue";
import { useRuntimeStatus } from "../../composables/useRuntimeStatus";
import { useTheme, type ThemePreference } from "../../composables/useTheme";
import { useAdminApi } from "../../composables/useAdminApi";

const navItems: Array<{ to: string; label: string; icon: Component }> = [
  { to: "/overview", label: "状态", icon: SlidersHorizontal },
  { to: "/conversations", label: "会话", icon: MessageSquare },
  { to: "/prompts", label: "提示词", icon: Bot },
  { to: "/memory", label: "记忆", icon: Brain },
  { to: "/images", label: "图像", icon: Image },
  { to: "/settings", label: "设置", icon: Settings }
];
const themeItems: Array<{ id: ThemePreference; label: string; icon: Component }> = [
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
  { id: "system", label: "系统", icon: Monitor }
];
const theme = useTheme();
const runtime = useRuntimeStatus();
const api = useAdminApi();

async function logout() {
  await api.logout();
  window.location.reload();
}
</script>

<template>
  <aside class="hidden h-full min-h-0 w-[88px] shrink-0 flex-col border-r border-line bg-panel lg:flex xl:w-[224px]">
    <div class="flex h-24 items-center gap-3 border-b border-line px-5 lg:px-6">
      <span class="grid size-11 shrink-0 place-items-center rounded-lg bg-display text-page">
        <Bot :size="22" :stroke-width="1.5" aria-hidden="true" />
      </span>
      <div class="hidden min-w-0 xl:block">
        <strong class="block text-lg font-medium tracking-[-0.02em] text-display">Sunabot</strong>
        <span class="block font-mono text-[10px] uppercase tracking-[0.08em] text-mute">Control 01</span>
      </div>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label="主导航">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="group flex min-h-12 items-center justify-center gap-3 rounded-lg px-3 font-mono text-xs text-disabled transition-colors duration-200 hover:bg-raised hover:text-display xl:justify-start"
        active-class="bg-raised !text-display"
      >
        <component :is="item.icon" :size="20" :stroke-width="1.5" aria-hidden="true" />
        <span class="hidden xl:inline">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="border-t border-line p-3">
      <div class="mb-3 hidden items-center justify-between px-2 xl:flex">
        <span class="meta-label">OneBot</span>
        <span class="font-mono text-[10px]" :class="runtime.status.value?.onebot.connected ? 'text-success' : 'text-mute'">
          {{ runtime.status.value?.onebot.connected ? "[ONLINE]" : "[OFFLINE]" }}
        </span>
      </div>
      <div class="grid grid-cols-1 gap-1 xl:grid-cols-3" aria-label="主题">
        <button
          v-for="item in themeItems"
          :key="item.id"
          class="grid min-h-11 place-items-center rounded-md text-disabled hover:bg-raised hover:text-display"
          :class="{ 'bg-raised text-display': theme.preference.value === item.id }"
          type="button"
          :title="item.label"
          @click="theme.setTheme(item.id)"
        >
          <component :is="item.icon" :size="17" :stroke-width="1.5" aria-hidden="true" />
          <span class="sr-only">{{ item.label }}</span>
        </button>
      </div>
      <button class="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-md font-mono text-[10px] text-disabled hover:bg-raised hover:text-display" type="button" @click="logout">
        <LogOut :size="16" :stroke-width="1.5" />
        <span class="hidden xl:inline">退出登录</span>
        <span class="sr-only xl:hidden">退出登录</span>
      </button>
    </div>
  </aside>
</template>
