<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useRoute } from "vue-router";
import { useTheme, type ThemePreference } from "../../composables/useTheme";
import DialogOverlay from "../ui/DialogOverlay.vue";

const route = useRoute();
const moreOpen = shallowRef(false);
const primary: Array<{ to: string; label: string; icon: string }> = [
  { to: "/overview", label: "状态", icon: "bx-pulse" },
  { to: "/conversations", label: "会话", icon: "bx-message-square-dots" },
  { to: "/prompts", label: "提示词", icon: "bx-bot" },
  { to: "/settings", label: "设置", icon: "bx-cog" }
];
const moreItems: Array<{ to: string; label: string; description: string; icon: string }> = [
  { to: "/memory", label: "记忆", description: "检索与维护记忆", icon: "bx-brain" },
  { to: "/images", label: "图像", description: "查看图像历史", icon: "bx-image" },
  { to: "/logs", label: "日志", description: "活动终端与请求日志", icon: "bx-terminal" }
];
const themeItems: Array<{ id: ThemePreference; label: string; icon: string }> = [
  { id: "light", label: "浅色", icon: "bx-sun" },
  { id: "dark", label: "深色", icon: "bx-moon" },
  { id: "system", label: "系统", icon: "bx-desktop" }
];
const moreActive = computed(() => ["/memory", "/images", "/logs"].some((path) => route.path.startsWith(path)));
const theme = useTheme();
</script>

<template>
  <nav class="fixed inset-x-0 bottom-0 z-40 grid h-[calc(68px+env(safe-area-inset-bottom))] grid-cols-5 border-t border-visible bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="主导航">
    <RouterLink
      v-for="item in primary"
      :key="item.to"
      :to="item.to"
      class="flex min-w-0 flex-col items-center justify-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em] text-disabled"
      active-class="!text-display"
    >
      <i class="bx text-xl" :class="item.icon" aria-hidden="true"></i>
      <span>{{ item.label }}</span>
    </RouterLink>
    <button class="flex min-w-0 flex-col items-center justify-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em]" :class="moreActive || moreOpen ? 'text-display' : 'text-disabled'" type="button" @click="moreOpen = true">
      <i class="bx bx-menu text-xl" aria-hidden="true"></i>
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
      <RouterLink
        v-for="item in moreItems"
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
      <div class="mt-2 border-t border-line pt-4">
        <span class="meta-label">主题</span>
        <div class="mt-3 grid grid-cols-3 gap-2" aria-label="主题">
          <button
            v-for="item in themeItems"
            :key="item.id"
            class="flex min-h-11 items-center justify-center gap-2 rounded-lg font-mono text-[10px] text-disabled"
            :class="theme.preference.value === item.id ? 'bg-raised text-display' : ''"
            type="button"
            @click="theme.setTheme(item.id)"
          >
            <i class="bx text-lg" :class="item.icon" aria-hidden="true"></i>
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </section>
  </DialogOverlay>
</template>
