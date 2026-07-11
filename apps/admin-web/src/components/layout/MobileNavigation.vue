<script setup lang="ts">
import { Bot, Brain, Image, LogOut, Menu, MessageSquare, Monitor, Moon, Settings, SlidersHorizontal, Sun, X } from "lucide-vue-next";
import { computed, shallowRef, type Component } from "vue";
import { useRoute } from "vue-router";
import { useTheme, type ThemePreference } from "../../composables/useTheme";
import { useAdminApi } from "../../composables/useAdminApi";
import DialogOverlay from "../ui/DialogOverlay.vue";

const route = useRoute();
const moreOpen = shallowRef(false);
const primary: Array<{ to: string; label: string; icon: Component }> = [
  { to: "/overview", label: "状态", icon: SlidersHorizontal },
  { to: "/conversations", label: "会话", icon: MessageSquare },
  { to: "/prompts", label: "提示词", icon: Bot },
  { to: "/settings", label: "设置", icon: Settings }
];
const moreItems: Array<{ to: string; label: string; description: string; icon: Component }> = [
  { to: "/memory", label: "记忆", description: "检索与维护六类记忆", icon: Brain },
  { to: "/images", label: "图像", description: "查看图像历史", icon: Image }
];
const themeItems: Array<{ id: ThemePreference; label: string; icon: Component }> = [
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
  { id: "system", label: "系统", icon: Monitor }
];
const moreActive = computed(() => route.path.startsWith("/memory") || route.path.startsWith("/images"));
const theme = useTheme();
const api = useAdminApi();

async function logout() {
  moreOpen.value = false;
  await api.logout();
  window.location.reload();
}
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
      <component :is="item.icon" :size="20" :stroke-width="1.5" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </RouterLink>
    <button class="flex min-w-0 flex-col items-center justify-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em]" :class="moreActive || moreOpen ? 'text-display' : 'text-disabled'" type="button" @click="moreOpen = true">
      <Menu :size="20" :stroke-width="1.5" aria-hidden="true" />
      <span>更多</span>
    </button>
  </nav>

  <DialogOverlay :open="moreOpen" class="lg:hidden" placement="bottom" :z-index="50" labelledby="mobile-more-title" @close="moreOpen = false">
    <section class="absolute inset-x-0 bottom-0 max-h-[calc(100dvh-16px)] overflow-y-auto rounded-t-2xl border-t border-visible bg-panel p-4 pb-[calc(24px+env(safe-area-inset-bottom))]">
      <div class="mx-auto mb-4 h-0.5 w-10 bg-visible"></div>
      <div class="mb-4 flex items-center justify-between">
        <h2 id="mobile-more-title" class="text-xl font-medium text-display">更多</h2>
        <button class="icon-btn" type="button" aria-label="关闭" @click="moreOpen = false">
          <X :size="20" :stroke-width="1.5" aria-hidden="true" />
        </button>
      </div>
      <RouterLink
        v-for="item in moreItems"
        :key="item.to"
        :to="item.to"
        class="flex min-h-16 items-center gap-4 border-t border-line px-1 text-ink first:border-t-0"
        @click="moreOpen = false"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" class="text-mute" aria-hidden="true" />
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
            <component :is="item.icon" :size="17" :stroke-width="1.5" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
      <button class="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-visible font-mono text-xs text-mute" type="button" @click="logout">
        <LogOut :size="17" />退出登录
      </button>
    </section>
  </DialogOverlay>
</template>
