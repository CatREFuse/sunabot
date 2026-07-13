<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useRoute } from "vue-router";
import { useTheme, type ThemePreference } from "../../composables/useTheme";
import DialogOverlay from "../ui/DialogOverlay.vue";
import AgentSwitcher from "../agents/AgentSwitcher.vue";

const route = useRoute();
const moreOpen = shallowRef(false);
const primary: Array<{ to: string; label: string; icon: string }> = [
  { to: "/overview", label: "状态", icon: "bx-pulse" },
  { to: "/web-chat", label: "Web Chat", icon: "bx-chat" },
  { to: "/conversations", label: "会话", icon: "bx-message-square-dots" },
  { to: "/agent-prompts", label: "提示词", icon: "bx-bot" },
  { to: "/agent-settings", label: "Agent", icon: "bx-slider-alt" }
];
const moreSections: Array<{
  label: string;
  items: Array<{ to: string; label: string; description: string; icon: string }>;
}> = [
  {
    label: "Agent",
    items: [
      { to: "/memory", label: "记忆", description: "检索与维护记忆", icon: "bx-brain" },
      { to: "/images", label: "图像", description: "查看图像历史", icon: "bx-image" },
      { to: "/logs", label: "日志", description: "活动终端与请求日志", icon: "bx-terminal" }
    ]
  },
  {
    label: "公共系统",
    items: [
      { to: "/settings", label: "系统设置", description: "模型、账户与连接", icon: "bx-cog" },
      { to: "/system-prompts", label: "系统提示词", description: "所有 Agent 的默认提示词", icon: "bx-file" }
    ]
  }
];
const themeItems: Array<{ id: ThemePreference; label: string; icon: string }> = [
  { id: "light", label: "浅色", icon: "bx-sun" },
  { id: "dark", label: "深色", icon: "bx-moon" },
  { id: "system", label: "系统", icon: "bx-desktop" }
];
const moreActive = computed(() => moreSections.some((section) => (
  section.items.some((item) => route.path.startsWith(item.to))
)));
const theme = useTheme();
</script>

<template>
  <nav class="fixed inset-x-0 bottom-0 z-40 grid h-[calc(68px+env(safe-area-inset-bottom))] grid-cols-6 border-t border-visible bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="主导航">
    <RouterLink
      v-for="item in primary"
      :key="item.to"
      :to="item.to"
      class="mobile-nav-link relative flex min-w-0 flex-col items-center justify-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em] text-disabled"
      active-class="is-active !text-display"
    >
      <i class="bx text-2xl" :class="item.icon" aria-hidden="true"></i>
      <span>{{ item.label }}</span>
    </RouterLink>
    <button class="mobile-nav-link relative flex min-w-0 flex-col items-center justify-center gap-1 bg-transparent font-mono text-[10px] uppercase tracking-[0.04em]" :class="moreActive || moreOpen ? 'is-active text-display' : 'text-disabled'" type="button" @click="moreOpen = true">
      <i class="bx bx-menu text-2xl" aria-hidden="true"></i>
      <span>更多</span>
    </button>
  </nav>

  <DialogOverlay :open="moreOpen" class="lg:hidden" placement="bottom" :z-index="50" labelledby="mobile-more-title" @close="moreOpen = false">
    <section class="absolute inset-x-0 bottom-0 max-h-[calc(100dvh-16px)] overflow-y-auto rounded-t-2xl border-t border-visible bg-panel p-4 pb-[calc(24px+env(safe-area-inset-bottom))]">
      <div class="mx-auto mb-4 h-0.5 w-10 bg-visible"></div>
      <div class="mb-4 flex items-center justify-between">
        <h2 id="mobile-more-title" class="text-xl font-medium text-display">更多</h2>
        <button class="icon-btn" type="button" aria-label="关闭" @click="moreOpen = false">
          <i class="bx bx-x text-2xl" aria-hidden="true"></i>
        </button>
      </div>
      <section v-for="section in moreSections" :key="section.label" class="border-t border-line py-3 first:border-t-0 first:pt-0">
        <h3 class="meta-label px-1 pb-2">{{ section.label }}</h3>
        <div v-if="section.label === 'Agent'" class="mb-2 border-y border-line py-2">
          <AgentSwitcher expanded />
        </div>
        <RouterLink
          v-for="item in section.items"
          :key="item.to"
          :to="item.to"
          class="flex min-h-16 items-center gap-4 border-t border-line px-1 text-ink first:border-t-0"
          @click="moreOpen = false"
        >
          <i class="bx text-2xl text-mute" :class="item.icon" aria-hidden="true"></i>
          <span class="min-w-0">
            <strong class="block font-normal text-display">{{ item.label }}</strong>
            <small class="block text-xs text-mute">{{ item.description }}</small>
          </span>
        </RouterLink>
      </section>
      <div class="mt-2 border-t border-line pt-4">
        <span class="meta-label">主题</span>
        <div class="mt-3 grid grid-cols-3 gap-2" aria-label="主题">
          <button
            v-for="item in themeItems"
            :key="item.id"
            class="theme-icon-button relative flex min-h-11 items-center justify-center gap-2 bg-transparent font-mono text-[10px] text-disabled transition-colors duration-200"
            :class="theme.preference.value === item.id ? 'text-display' : ''"
            type="button"
            :aria-pressed="theme.preference.value === item.id"
            @click="theme.setTheme(item.id)"
          >
            <i class="bx text-2xl" :class="item.icon" aria-hidden="true"></i>
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </section>
  </DialogOverlay>
</template>

<style scoped>
.mobile-nav-link::before,
.theme-icon-button::after {
  position: absolute;
  content: "";
  background: rgb(var(--color-display));
  opacity: 0;
  transition: opacity 180ms cubic-bezier(0.25, 0.1, 0.25, 1);
}

.mobile-nav-link::before {
  top: 5px;
  left: 50%;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  transform: translateX(-50%);
}

.mobile-nav-link.is-active::before {
  opacity: 1;
}

.theme-icon-button::after {
  right: 50%;
  bottom: 2px;
  width: 16px;
  height: 2px;
  transform: translateX(50%);
}

.theme-icon-button[aria-pressed="true"]::after {
  opacity: 1;
}
</style>
